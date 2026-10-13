from dataclasses import dataclass
import sqlite3
import hashlib
import json
import time
from contextlib import closing
from mail_ids import with_aliases
from datetime import datetime
import assets
from pyasn1_modules.rfc2459 import SubjectAltName

class DBmanage :
    def __init__(self,name):
        self.DBname = name

    def R_for_category_options(self, connection=None):
        read_conn = connection if connection is not None else sqlite3.connect(self.DBname)
        try:
            rows = read_conn.execute("""
                SELECT DISTINCT trim(MainCategory), trim(SubCategory) FROM (
                    SELECT MainCategory, SubCategory FROM ShopName
                    UNION SELECT MainCategory, SubCategory FROM DealingData
                    UNION SELECT MainCategory, SubCategory FROM ADRresults
                ) WHERE trim(COALESCE(MainCategory, '')) NOT IN ('', '未分类', '待分类')
                    AND trim(COALESCE(SubCategory, '')) NOT IN ('', '未分类', '待分类')
                ORDER BY 1, 2
            """).fetchall()
            return [{"main_category": row[0], "sub_category": row[1]} for row in rows]
        finally:
            if connection is None:
                read_conn.close()

    @staticmethod
    def ensure_mail_source_columns(conn):
        # Nullable provenance only; existing records are not inferred or backfilled.
        for table in ("DealingData", "ADRresults"):
            columns = {row[1].lower() for row in conn.execute(f"PRAGMA table_info({table})")}
            if columns and "msgid" not in columns:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN msgid TEXT DEFAULT NULL")

    def _ensure_runtime_schema(self, conn):
        self.ensure_mail_source_columns(conn)
        assets.ensure_asset_schema(conn)
        cursor = conn.cursor()
        try:
            cursor.execute("PRAGMA table_info(DealingData)")
            dealing_columns = {row[1] for row in cursor.fetchall()}
            refresh_adr_result_counts = False
            if dealing_columns and "DetailCategory" not in dealing_columns:
                cursor.execute(
                    """
                    ALTER TABLE DealingData
                    ADD COLUMN DetailCategory TEXT DEFAULT ''
                    """
                )
                dealing_columns.add("DetailCategory")

            if dealing_columns and "ADRresult" not in dealing_columns:
                cursor.execute(
                    """
                    ALTER TABLE DealingData
                    ADD COLUMN ADRresult INTEGER DEFAULT NULL
                    """
                )
                dealing_columns.add("ADRresult")
                refresh_adr_result_counts = True

            cursor.execute("PRAGMA table_info(ADRresults)")
            adr_columns = {row[1] for row in cursor.fetchall()}
            if adr_columns:
                if "MainCatgory" in adr_columns and "MainCategory" not in adr_columns:
                    cursor.execute(
                        """
                        ALTER TABLE ADRresults
                        RENAME COLUMN MainCatgory TO MainCategory
                        """
                    )
                    adr_columns.remove("MainCatgory")
                    adr_columns.add("MainCategory")

                if "DetailCategory" not in adr_columns:
                    cursor.execute(
                        """
                        ALTER TABLE ADRresults
                        ADD COLUMN DetailCategory TEXT DEFAULT ''
                        """
                    )
                    adr_columns.add("DetailCategory")

                if "ProductName" not in adr_columns:
                    cursor.execute(
                        """
                        ALTER TABLE ADRresults
                        ADD COLUMN ProductName TEXT DEFAULT ''
                        """
                    )
                    adr_columns.add("ProductName")

                if "Quantity" not in adr_columns:
                    cursor.execute(
                        """
                        ALTER TABLE ADRresults
                        ADD COLUMN Quantity REAL DEFAULT NULL
                        """
                    )
                    adr_columns.add("Quantity")

            if (
                dealing_columns
                and adr_columns
                and "ADRresult" in dealing_columns
                and not refresh_adr_result_counts
            ):
                cursor.execute(
                    """
                    SELECT 1
                    FROM DealingData
                    WHERE ADRresult = 0
                    LIMIT 1
                    """
                )
                refresh_adr_result_counts = cursor.fetchone() is not None

            if dealing_columns and adr_columns and "ADRresult" in dealing_columns and refresh_adr_result_counts:
                cursor.execute(
                    """
                    UPDATE DealingData
                    SET ADRresult = (
                        SELECT CASE
                            WHEN COUNT(*) = 0 THEN NULL
                            ELSE COUNT(*)
                        END
                        FROM ADRresults
                        WHERE ADRresults.DealingNumber = DealingData.DealingNumber
                    )
                    """
                )

            conn.commit()
        finally:
            cursor.close()

    def _refresh_dealing_adr_result_count(self, conn, DealingNumber):
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                UPDATE DealingData
                SET ADRresult = (
                    SELECT CASE
                        WHEN COUNT(*) = 0 THEN NULL
                        ELSE COUNT(*)
                    END
                    FROM ADRresults
                    WHERE ADRresults.DealingNumber = ?
                )
                WHERE DealingNumber = ?
                """,
                (DealingNumber, DealingNumber)
            )
        finally:
            cursor.close()

    def connect_db(self,database_name):
        global conn
        self.DBname = database_name
        conn = sqlite3.connect(database_name)
        self._ensure_runtime_schema(conn)

    @staticmethod
    def dealing_payload(shop_name, price, CurrencyTypeNumber, isotime, main_category, sub_category, AccountNumber, detail_category="", msgid=None, settled_amount=None):
        return dict(shop_name=shop_name, price=price, currency=CurrencyTypeNumber,
                    time=isotime, main_category=main_category, sub_category=sub_category,
                    account=AccountNumber, detail_category=detail_category, msgid=msgid,
                    settled_amount=settled_amount)

    @staticmethod
    def insert_dealing(connection, payload, operation_id):
        # The caller owns the transaction, including duplicate checks and balance changes.
        cursor = connection.execute("""INSERT INTO DealingData
            (ShopName,price,CurrencyTypeNumber,ISOtime,MainCategory,SubCategory,AccountNumber,DetailCategory,msgid)
            VALUES (?,?,?,?,?,?,?,?,?)""",
            (payload["shop_name"], payload["price"], payload["currency"], payload["time"],
             payload["main_category"], payload["sub_category"], payload["account"],
             payload["detail_category"], payload["msgid"] or None))
        number = cursor.lastrowid
        sync = assets.apply_dealing_change(connection, None, assets.read_dealing(connection, number),
                                          operation_id, payload["settled_amount"])
        return {"DealingNumber": number, "balance_sync": sync}

    def C_for_DealingDate(self, shop_name, price, CurrencyTypeNumber, isotime, main_category, sub_category, AccountNumber, detail_category="", msgid=None, operation_id=None, settled_amount=None, check_ocr_duplicate=False):
        write_conn = sqlite3.connect(self.DBname, timeout=10)
        self.last_asset_result = None
        self.last_write_error = None
        self.last_write_status = 400
        payload = self.dealing_payload(shop_name, price, CurrencyTypeNumber, isotime, main_category,
                                       sub_category, AccountNumber, detail_category, msgid, settled_amount)
        if operation_id is None and msgid:
            operation_id = "mail-dealing:" + hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
        try:
            self._ensure_runtime_schema(write_conn)
            write_conn.execute("BEGIN IMMEDIATE")
            def create(key):
                if check_ocr_duplicate:
                    allowed = {(row["main_category"], row["sub_category"])
                               for row in self.R_for_category_options(write_conn)}
                    if (main_category, sub_category) not in allowed:
                        raise assets.AssetError("OCR category must be an existing category pair", 409)
                    if AccountNumber is not None:
                        if type(AccountNumber) is not int:
                            raise assets.AssetError("OCR account number must be an integer", 409)
                        account = assets.get_account(write_conn, AccountNumber)
                        if assets.currency(account["CurrencyType"]) != assets.currency(CurrencyTypeNumber):
                            raise assets.AssetError("OCR account currency requires review", 409)
                    # Close the gap between Agent lookup and insert without changing other writers.
                    stamp = datetime.fromisoformat(assets.timestamp(isotime))
                    rows = write_conn.execute(
                        "SELECT DealingNumber, ISOtime FROM DealingData "
                        "WHERE CurrencyTypeNumber = ? AND ABS(price - ?) <= 0.01000001",
                        (CurrencyTypeNumber, price),
                    )
                    for number, saved_time in rows:
                        date = datetime.fromisoformat(assets.timestamp(saved_time))
                        if abs((date - stamp).total_seconds()) <= 120:
                            raise assets.AssetError("OCR duplicate candidate requires judgment: " + str(number), 409)
                return self.insert_dealing(write_conn, payload, key)
            self.last_asset_result = assets.run_operation(write_conn, operation_id, "dealing.create", payload,
                create)
            write_conn.commit()
            return 100
        except Exception as error:
            write_conn.rollback()
            self.last_write_error = str(error)
            self.last_write_status = getattr(error, "status", 500)
            return 400
        finally:
            write_conn.close()

    def R_get_ShopName(self,key):
        cursor = conn.cursor()
        try:
            cursor.execute(
                    """
                SELECT ShopName, MainCategory, SubCategory
                FROM ShopName
                WHERE key = ?
                """,
                (key,)
            )
            conn.commit()
            row = cursor.fetchone()
            cursor.close()
        except Exception as e:
            print(f"Error occurred: {e}")

        list_row= list(row)
        ShopName,MainCategory,SubCategory = list_row[0],list_row[1],list_row[2]
        return ShopName,MainCategory,SubCategory

    def R_for_ShopName(self, key):#查询是否在list中有对应的shopname，没有返回none
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
            SELECT ShopName, MainCategory, SubCategory
            FROM ShopName
            WHERE key = ?
            """,
                (key,)
            )
            conn.commit()
            row = cursor.fetchone()
            cursor.close()
        except Exception as e:
            print(f"Error occurred: {e}")
        return row

    def R_for_DoneList(self,MsgID):
        # A Gmail mail done under its other ID (Google sign-in or app password) is done too.
        ids = with_aliases(MsgID)
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                "SELECT 1 FROM DoneList WHERE MsgID IN (" + ",".join("?" * len(ids)) + ") LIMIT 1",
                ids
            )
            conn.commit()
            row = cursor.fetchone()
            cursor.close()
        except Exception as e:
            print(f"Error occurred: {e}")
        return row is None

    def C_for_DoneList(self,MsgID):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
            INSERT INTO DoneList (MsgID) VALUES (?)
            """,
                (MsgID,)
            )
            conn.commit()
            row = cursor.fetchone()
            cursor.close()
        except Exception as e:
            print(f"Error occurred: {e}")

    def ensure_ADRVectorDoneList(self):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS ADRVectorDoneList (
                    MsgID TEXT PRIMARY KEY,
                    SourceType TEXT,
                    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()
            return 100
        except Exception as e:
            print(f"Error occurred: {e}")
            conn.rollback()
            return 400
        finally:
            cursor.close()
            conn.close()

    def R_for_ADRVectorDoneList(self, MsgID):
        self.ensure_ADRVectorDoneList()
        ids = with_aliases(MsgID)
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                "SELECT 1 FROM ADRVectorDoneList WHERE MsgID IN (" + ",".join("?" * len(ids)) + ") LIMIT 1",
                ids
            )
            row = cursor.fetchone()
            return row is None
        except Exception as e:
            print(f"Error occurred: {e}")
            return False
        finally:
            cursor.close()
            conn.close()

    def C_for_ADRVectorDoneList(self, MsgID, SourceType="gmail"):
        self.ensure_ADRVectorDoneList()
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                INSERT OR IGNORE INTO ADRVectorDoneList (MsgID, SourceType)
                VALUES (?, ?)
                """,
                (MsgID, SourceType)
            )
            conn.commit()
            return 100
        except Exception as e:
            print(f"Error occurred: {e}")
            conn.rollback()
            return 400
        finally:
            cursor.close()
            conn.close()

    def ensure_OCRDoneList(self):
        with sqlite3.connect(self.DBname) as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS OCRDoneList (SourceID TEXT PRIMARY KEY, ImagePath TEXT NOT NULL)")

    def R_for_OCRDoneList(self, source_id):
        self.ensure_OCRDoneList()
        ids = with_aliases(source_id)
        with sqlite3.connect(self.DBname) as conn:
            row = conn.execute("SELECT ImagePath FROM OCRDoneList WHERE SourceID IN (" + ",".join("?" * len(ids)) + ") LIMIT 1",
                               ids).fetchone()
        return None if row is None else {"SourceID": source_id, "ImagePath": row[0]}

    def C_for_OCRDoneList(self, source_id, image_path):
        self.ensure_OCRDoneList()
        with sqlite3.connect(self.DBname) as conn:
            conn.execute("INSERT INTO OCRDoneList (SourceID, ImagePath) VALUES (?, ?) "
                         "ON CONFLICT(SourceID) DO UPDATE SET ImagePath = excluded.ImagePath",
                         (source_id, image_path))
        return 100

    def R_for_dealing_source(self, source_id):
        ids = with_aliases(source_id)
        with sqlite3.connect(self.DBname) as conn:
            return conn.execute("SELECT DealingNumber FROM DealingData WHERE msgid IN (" + ",".join("?" * len(ids)) + ") LIMIT 1",
                                ids).fetchone()

    def mark_ocr_bill_done(self, source_id):
        with sqlite3.connect(self.DBname) as conn:
            conn.execute("INSERT INTO DoneList (MsgID) SELECT ? "
                         "WHERE NOT EXISTS (SELECT 1 FROM DoneList WHERE MsgID = ?)",
                         (source_id, source_id))

    OCR_BILLING_MAX_ATTEMPTS = 3
    OCR_BILLING_RETRY_SECONDS = 3600

    @staticmethod
    def _ensure_ocr_billing_retry(conn):
        # Billing decisions have a separate lifecycle from cached image/OCR evidence.
        conn.execute("""CREATE TABLE IF NOT EXISTS OCRBillingRetry (
            SourceID TEXT PRIMARY KEY,
            Attempts INTEGER NOT NULL DEFAULT 0,
            State TEXT NOT NULL,
            RetryAt REAL NOT NULL DEFAULT 0
        )""")

    def ocr_billing_state(self, source_id):
        with closing(sqlite3.connect(self.DBname)) as conn, conn:
            self._ensure_ocr_billing_retry(conn)
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM OCRBillingRetry WHERE SourceID = ?",
                               (str(source_id),)).fetchone()
            return dict(row) if row else None

    def ocr_billing_eligible(self, msgid, now=None):
        if not self.R_for_DoneList(str(msgid)):
            return False
        row = self.ocr_billing_state(msgid)
        now = time.time() if now is None else now
        return row is None or (
            row["State"] in {"running", "retry"}
            and row["Attempts"] < self.OCR_BILLING_MAX_ATTEMPTS
            and row["RetryAt"] <= now
        )

    def claim_ocr_billing(self, msgid, now=None):
        now = time.time() if now is None else now
        with closing(sqlite3.connect(self.DBname)) as conn, conn:
            self._ensure_ocr_billing_retry(conn)
            # Claim before external calls so restarts/timeouts cannot create a hot loop.
            cursor = conn.execute("""INSERT INTO OCRBillingRetry
                (SourceID, Attempts, State, RetryAt) VALUES (?, 1, 'running', ?)
                ON CONFLICT(SourceID) DO UPDATE SET
                    Attempts = Attempts + 1, State = 'running', RetryAt = excluded.RetryAt
                WHERE OCRBillingRetry.State IN ('running', 'retry')
                    AND OCRBillingRetry.Attempts < ? AND OCRBillingRetry.RetryAt <= ?""",
                (str(msgid), now + self.OCR_BILLING_RETRY_SECONDS,
                 self.OCR_BILLING_MAX_ATTEMPTS, now))
            return cursor.rowcount == 1

    def finish_ocr_billing(self, source_id, state, now=None):
        if state not in {"review", "retry", "done"}:
            raise ValueError("Invalid OCR billing state")
        now = time.time() if now is None else now
        retry_at = now + self.OCR_BILLING_RETRY_SECONDS if state == "retry" else 0
        with closing(sqlite3.connect(self.DBname)) as conn, conn:
            self._ensure_ocr_billing_retry(conn)
            conn.execute("""INSERT INTO OCRBillingRetry (SourceID, Attempts, State, RetryAt)
                VALUES (?, 0, ?, ?) ON CONFLICT(SourceID) DO UPDATE SET
                    State = excluded.State, RetryAt = excluded.RetryAt""",
                (str(source_id), state, retry_at))

    def reset_ocr_billing_retry(self, msgid):
        # Explicit retry keeps successful billing and evidence/download deduplication intact.
        prefix = "ocr:" + str(msgid) + ":"
        with closing(sqlite3.connect(self.DBname)) as conn, conn:
            self._ensure_ocr_billing_retry(conn)
            conn.execute("DELETE FROM OCRBillingRetry WHERE SourceID = ? "
                         "OR substr(SourceID, 1, length(?)) = ?", (str(msgid), prefix, prefix))

    def ensure_ADRDoneList(self):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS ADRDoneList (
                    MsgID TEXT PRIMARY KEY,
                    SourceType TEXT,
                    ADRStatus TEXT,
                    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()
            return 100
        except Exception as e:
            print(f"Error occurred: {e}")
            conn.rollback()
            return 400
        finally:
            cursor.close()
            conn.close()

    def R_for_ADRDoneList(self, MsgID):
        """Return whether evidence still needs OCR/import, including downloaded images."""
        self.ensure_ADRDoneList()
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            ids = with_aliases(MsgID)
            cursor.execute(
                "SELECT ADRStatus FROM ADRDoneList WHERE MsgID IN (" + ",".join("?" * len(ids)) + ")",
                ids
            )
            return all(status == "downloaded" for (status,) in cursor.fetchall())
        except Exception as e:
            print(f"Error occurred: {e}")
            return False
        finally:
            cursor.close()
            conn.close()

    def C_for_ADRDoneList(self, MsgID, SourceType="ocr", ADRStatus="success"):
        self.ensure_ADRDoneList()
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                INSERT INTO ADRDoneList (MsgID, SourceType, ADRStatus)
                VALUES (?, ?, ?)
                ON CONFLICT(MsgID) DO UPDATE SET
                    SourceType = excluded.SourceType,
                    ADRStatus = excluded.ADRStatus
                WHERE ADRDoneList.ADRStatus = 'downloaded'
                  AND excluded.ADRStatus IN ('success', 'skipped')
                """,
                (MsgID, SourceType, ADRStatus)
            )
            conn.commit()
            return 100
        except Exception as e:
            print(f"Error occurred: {e}")
            conn.rollback()
            return 400
        finally:
            cursor.close()
            conn.close()


    def C_for_UnknownShopName(self,key):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
            INSERT INTO UnknownShopName (TitleValue) VALUES (?)
            """,
                (key,)
            )
            conn.commit()
            row = cursor.fetchone()
            cursor.close()
        except Exception as e:
            print(f"Error occurred: {e}")

    def C_for_ShopName(self, key, main_category, sub_category, shop_name):
        """
        将4个变量写入 ShopName 表：
        key, ShopName, MainCategory, SubCategory
        """
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        success = True
        try: 
            cursor.execute(
                    """
                    INSERT INTO ShopName (key,MainCategory, SubCategory ,ShopName )
                    VALUES (?, ?, ?, ?)
                    """,
                    (key, main_category, sub_category, shop_name)
                )
            conn.commit()

        except Exception as e:
            print(f"Error occurred: {e}")
            success = False
            conn.rollback()
        finally:
            cursor.close()
            conn.close()

        return 100 if success else 400

##对于OCR结果的数据库操作，设计了一个新的表OCRresults，包含msgid、OCRresults和SID三个字段。以下是对这个表的增删改查操作：
    def C_for_OCRresults(self, msgid, ocr_results, sid=None):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                INSERT INTO OCRresults (msgid, OCRresults, SID)
                VALUES (?, ?, ?)
                """,
                (msgid, ocr_results, sid)
            )
            conn.commit()
            return 100

        except Exception as e:
            print(f"Error occurred: {e}")
            return 400

        finally:
            cursor.close()
            conn.close()


    def R_for_OCRresults_by_msgid(self, msgid):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT msgid, OCRresults, SID
                FROM OCRresults
                WHERE msgid = ?
                """,
                (msgid,)
            )
            row = cursor.fetchone()
            return row

        except Exception as e:
            print(f"Error occurred: {e}")
            return None

        finally:
            cursor.close()
            conn.close()


    def R_for_OCRresults_by_sid(self, sid):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT msgid, OCRresults, SID
                FROM OCRresults
                WHERE SID = ?
                """,
                (sid,)
            )
            rows = cursor.fetchall()
            return rows

        except Exception as e:
            print(f"Error occurred: {e}")
            return []

        finally:
            cursor.close()
            conn.close()


    def R_for_all_OCRresults(self):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT msgid, OCRresults, SID
                FROM OCRresults
                ORDER BY rowid DESC
                """
            )
            rows = cursor.fetchall()
            return rows

        except Exception as e:
            print(f"Error occurred: {e}")
            return []

        finally:
            cursor.close()
            conn.close()

    def U_for_OCRresults_sid(self, msgid, sid):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                UPDATE OCRresults
                SET SID = ?
                WHERE msgid = ?
                """,
                (sid, msgid)
            )
            conn.commit()
            return cursor.rowcount

        except Exception as e:
            print(f"Error occurred: {e}")
            return 0

        finally:
            cursor.close()
            conn.close()

    def R_for_OCRresults_search(self, msgid=None, ocr_results=None, sid=None, max_results=10):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            sql = """
                SELECT msgid, OCRresults, SID
                FROM OCRresults
                WHERE 1 = 1
            """
            params = []

            if msgid:
                sql += " AND msgid = ?"
                params.append(msgid)

            if ocr_results:
                sql += " AND OCRresults LIKE ?"
                params.append(f"%{ocr_results}%")

            if sid is not None:
                sql += " AND SID = ?"
                params.append(sid)

            sql += " ORDER BY rowid DESC LIMIT ?"
            params.append(max_results)

            cursor.execute(sql, params)
            rows = cursor.fetchall()
            return rows

        except Exception as e:
            print(f"Error occurred: {e}")
            return []

        finally:
            cursor.close()
            conn.close()

        # =========================
        # ShopName 表补充：读 / 改 / 删 / 搜索
        # 表头: key, MainCategory, SubCategory, ShopName
        # =========================

    def R_for_ShopName_by_key(self, key):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
                cursor.execute(
                    """
                    SELECT key, MainCategory, SubCategory, ShopName
                    FROM ShopName
                    WHERE key = ?
                    """,
                    (key,)
                )
                row = cursor.fetchone()
                return row
        except Exception as e:
                print(f"Error occurred: {e}")
                return None
        finally:
                cursor.close()
                conn.close()

    def R_for_all_ShopName(self):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                SELECT key, MainCategory, SubCategory, ShopName
                FROM ShopName
                ORDER BY key
                """
            )
            rows = cursor.fetchall()
            return rows
        except Exception as e:
            print(f"Error occurred: {e}")
            return []
        finally:
            cursor.close()
            conn.close()

    def U_for_ShopName(self, key, main_category, sub_category, shop_name):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                UPDATE ShopName
                SET MainCategory = ?, SubCategory = ?, ShopName = ?
                WHERE key = ?
                """,
                (main_category, sub_category, shop_name, key)
            )
            conn.commit()
            return cursor.rowcount
        except Exception as e:
            print(f"Error occurred: {e}")
            return 0
        finally:
            cursor.close()
            conn.close()

    def D_for_ShopName(self, key):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                DELETE FROM ShopName
                WHERE key = ?
                """,
                (key,)
            )
            conn.commit()
            return cursor.rowcount
        except Exception as e:
            print(f"Error occurred: {e}")
            return 0
        finally:
            cursor.close()
            conn.close()

    def R_for_ShopName_search(self, key=None, main_category=None, sub_category=None, shop_name=None, max_results=20):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            sql = """
                SELECT key, MainCategory, SubCategory, ShopName
                FROM ShopName
                WHERE 1=1
            """
            params = []

            if key:
                sql += " AND key LIKE ?"
                params.append(f"%{key}%")
            if main_category:
                sql += " AND MainCategory LIKE ?"
                params.append(f"%{main_category}%")
            if sub_category:
                sql += " AND SubCategory LIKE ?"
                params.append(f"%{sub_category}%")
            if shop_name:
                sql += " AND ShopName LIKE ?"
                params.append(f"%{shop_name}%")

            sql += " ORDER BY key LIMIT ?"
            params.append(max_results)

            cursor.execute(sql, params)
            rows = cursor.fetchall()
            return rows
        except Exception as e:
            print(f"Error occurred: {e}")
            return []
        finally:
            cursor.close()
            conn.close()

        # =========================
        # UnknownShopName 表补充：读 / 改 / 删 / 搜索
        # 表头: TitleValue
        # =========================

    def R_for_UnknownShopName_by_title(self, title_value):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                SELECT TitleValue
                FROM UnknownShopName
                WHERE TitleValue = ?
                """,
                (title_value,)
            )
            row = cursor.fetchone()
            return row
        except Exception as e:
            print(f"Error occurred: {e}")
            return None
        finally:
            cursor.close()
            conn.close()

    def R_for_all_UnknownShopName(self):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                SELECT TitleValue
                FROM UnknownShopName
                ORDER BY TitleValue
                """
            )
            rows = cursor.fetchall()
            return rows
        except Exception as e:
            print(f"Error occurred: {e}")
            return []
        finally:
            cursor.close()
            conn.close()

    def U_for_UnknownShopName(self, old_title_value, new_title_value):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                UPDATE UnknownShopName
                SET TitleValue = ?
                WHERE TitleValue = ?
                """,
                (new_title_value, old_title_value)
            )
            conn.commit()
            return cursor.rowcount
        except Exception as e:
            print(f"Error occurred: {e}")
            return 0
        finally:
            cursor.close()
            conn.close()

    def D_for_UnknownShopName(self, title_value):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                DELETE FROM UnknownShopName
                WHERE TitleValue = ?
                """,
                (title_value,)
            )
            conn.commit()
            return cursor.rowcount
        except Exception as e:
            print(f"Error occurred: {e}")
            return 0
        finally:
            cursor.close()
            conn.close()

    def R_for_UnknownShopName_search(self, title_value=None, max_results=20):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()
        try:
            sql = """
                SELECT TitleValue
                FROM UnknownShopName
                WHERE 1=1
            """
            params = []

            if title_value:
                sql += " AND TitleValue LIKE ?"
                params.append(f"%{title_value}%")

            sql += " ORDER BY TitleValue LIMIT ?"
            params.append(max_results)

            cursor.execute(sql, params)
            rows = cursor.fetchall()
            return rows
        except Exception as e:
            print(f"Error occurred: {e}")
            return []
        finally:
            cursor.close()
            conn.close()

    # =========================
    # ADRresults 表增删改查
    # 表头:
    # DealingNumber, CurrencyTypeNumber, ShopName, ISOtime,
    # MainCategory, SubCategory, AccountNumber, SubDealingNumber, price
    # =========================

    def C_for_ADRresults(
        self,
        DealingNumber,
        CurrencyTypeNumber,
        ShopName,
        ISOtime,
        MainCategory,
        SubCategory,
        AccountNumber,
        SubDealingNumber,
        price,
        DetailCategory="",
        ProductName="",
        Quantity=None,
        msgid=None
    ):
        conn = sqlite3.connect(self.DBname)
        self._ensure_runtime_schema(conn)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                INSERT INTO ADRresults (
                    DealingNumber,
                    CurrencyTypeNumber,
                    ShopName,
                    ProductName,
                    Quantity,
                    ISOtime,
                    MainCategory,
                    SubCategory,
                    DetailCategory,
                    AccountNumber,
                    SubDealingNumber,
                    price,
                    msgid
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    DealingNumber,
                    CurrencyTypeNumber,
                    ShopName,
                    ProductName,
                    Quantity,
                    ISOtime,
                    MainCategory,
                    SubCategory,
                    DetailCategory,
                    AccountNumber,
                    SubDealingNumber,
                    price,
                    msgid or None
                )
            )
            self._refresh_dealing_adr_result_count(conn, DealingNumber)
            conn.commit()
            return 100

        except Exception as e:
            print(f"Error occurred: {e}")
            return 400

        finally:
            cursor.close()
            conn.close()


    def R_for_ADRresults_by_dealing_number(self, DealingNumber):
        conn = sqlite3.connect(self.DBname)
        self._ensure_runtime_schema(conn)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT
                    DealingNumber,
                    CurrencyTypeNumber,
                    ShopName,
                    ProductName,
                    Quantity,
                    ISOtime,
                    MainCategory,
                    SubCategory,
                    DetailCategory,
                    AccountNumber,
                    SubDealingNumber,
                    price
                FROM ADRresults
                WHERE DealingNumber = ?
                ORDER BY SubDealingNumber
                """,
                (DealingNumber,)
            )
            rows = cursor.fetchall()
            return rows

        except Exception as e:
            print(f"Error occurred: {e}")
            return []

        finally:
            cursor.close()
            conn.close()


    def R_for_ADRresults_by_sub_dealing_number(self, DealingNumber, SubDealingNumber):
        conn = sqlite3.connect(self.DBname)
        self._ensure_runtime_schema(conn)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT
                    DealingNumber,
                    CurrencyTypeNumber,
                    ShopName,
                    ProductName,
                    Quantity,
                    ISOtime,
                    MainCategory,
                    SubCategory,
                    DetailCategory,
                    AccountNumber,
                    SubDealingNumber,
                    price
                FROM ADRresults
                WHERE DealingNumber = ? AND SubDealingNumber = ?
                """,
                (DealingNumber, SubDealingNumber)
            )
            row = cursor.fetchone()
            return row

        except Exception as e:
            print(f"Error occurred: {e}")
            return None

        finally:
            cursor.close()
            conn.close()


    def R_for_all_ADRresults(self):
        conn = sqlite3.connect(self.DBname)
        self._ensure_runtime_schema(conn)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT
                    DealingNumber,
                    CurrencyTypeNumber,
                    ShopName,
                    ProductName,
                    Quantity,
                    ISOtime,
                    MainCategory,
                    SubCategory,
                    DetailCategory,
                    AccountNumber,
                    SubDealingNumber,
                    price
                FROM ADRresults
                ORDER BY DealingNumber DESC, SubDealingNumber ASC
                """
            )
            rows = cursor.fetchall()
            return rows

        except Exception as e:
            print(f"Error occurred: {e}")
            return []

        finally:
            cursor.close()
            conn.close()


    def U_for_ADRresults(
        self,
        DealingNumber,
        SubDealingNumber,
        CurrencyTypeNumber,
        ShopName,
        ISOtime,
        MainCategory,
        SubCategory,
        AccountNumber,
        price,
        DetailCategory="",
        ProductName="",
        Quantity=None
    ):
        conn = sqlite3.connect(self.DBname)
        self._ensure_runtime_schema(conn)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                UPDATE ADRresults
                SET
                    CurrencyTypeNumber = ?,
                    ShopName = ?,
                    ProductName = ?,
                    Quantity = ?,
                    ISOtime = ?,
                    MainCategory = ?,
                    SubCategory = ?,
                    DetailCategory = ?,
                    AccountNumber = ?,
                    price = ?
                WHERE DealingNumber = ? AND SubDealingNumber = ?
                """,
                (
                    CurrencyTypeNumber,
                    ShopName,
                    ProductName,
                    Quantity,
                    ISOtime,
                    MainCategory,
                    SubCategory,
                    DetailCategory,
                    AccountNumber,
                    price,
                    DealingNumber,
                    SubDealingNumber
                )
            )
            if cursor.rowcount:
                self._refresh_dealing_adr_result_count(conn, DealingNumber)
            conn.commit()
            return cursor.rowcount

        except Exception as e:
            print(f"Error occurred: {e}")
            return 0

        finally:
            cursor.close()
            conn.close()


    def D_for_ADRresults(self, DealingNumber, SubDealingNumber):
        conn = sqlite3.connect(self.DBname)
        self._ensure_runtime_schema(conn)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                DELETE FROM ADRresults
                WHERE DealingNumber = ? AND SubDealingNumber = ?
                """,
                (DealingNumber, SubDealingNumber)
            )
            if cursor.rowcount:
                self._refresh_dealing_adr_result_count(conn, DealingNumber)
            conn.commit()
            return cursor.rowcount

        except Exception as e:
            print(f"Error occurred: {e}")
            return 0

        finally:
            cursor.close()
            conn.close()


    def R_for_ADRresults_search(
        self,
        DealingNumber=None,
        CurrencyTypeNumber=None,
        ShopName=None,
        ISOtime=None,
        MainCategory=None,
        SubCategory=None,
        DetailCategory=None,
        ProductName=None,
        Quantity=None,
        AccountNumber=None,
        SubDealingNumber=None,
        price=None,
        max_results=20
    ):
        conn = sqlite3.connect(self.DBname)
        self._ensure_runtime_schema(conn)
        cursor = conn.cursor()

        try:
            sql = """
                SELECT
                    DealingNumber,
                    CurrencyTypeNumber,
                    ShopName,
                    ProductName,
                    Quantity,
                    ISOtime,
                    MainCategory,
                    SubCategory,
                    DetailCategory,
                    AccountNumber,
                    SubDealingNumber,
                    price
                FROM ADRresults
                WHERE 1=1
            """
            params = []

            if DealingNumber is not None:
                sql += " AND DealingNumber = ?"
                params.append(DealingNumber)

            if CurrencyTypeNumber is not None:
                sql += " AND CurrencyTypeNumber = ?"
                params.append(CurrencyTypeNumber)

            if ShopName:
                sql += " AND ShopName LIKE ?"
                params.append(f"%{ShopName}%")

            if ProductName:
                sql += " AND ProductName LIKE ?"
                params.append(f"%{ProductName}%")

            if Quantity is not None:
                sql += " AND Quantity = ?"
                params.append(Quantity)

            if ISOtime:
                sql += " AND ISOtime LIKE ?"
                params.append(f"%{ISOtime}%")

            if MainCategory:
                sql += " AND MainCategory LIKE ?"
                params.append(f"%{MainCategory}%")

            if SubCategory:
                sql += " AND SubCategory LIKE ?"
                params.append(f"%{SubCategory}%")

            if DetailCategory:
                sql += " AND DetailCategory LIKE ?"
                params.append(f"%{DetailCategory}%")

            if AccountNumber is not None:
                sql += " AND AccountNumber = ?"
                params.append(AccountNumber)

            if SubDealingNumber is not None:
                sql += " AND SubDealingNumber = ?"
                params.append(SubDealingNumber)

            if price is not None:
                sql += " AND price = ?"
                params.append(price)

            sql += " ORDER BY DealingNumber DESC, SubDealingNumber ASC LIMIT ?"
            params.append(max_results)

            cursor.execute(sql, params)
            rows = cursor.fetchall()
            return rows

        except Exception as e:
            print(f"Error occurred: {e}")
            return []

        finally:
            cursor.close()
            conn.close()
