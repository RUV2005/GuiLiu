from runtime_settings import configure_utf8

configure_utf8()

import os
import uuid
import logging
import threading
from datetime import datetime
from typing import Any
import os
from typing import Iterable

from dotenv import load_dotenv
from openai import OpenAI
import lancedb
import pyarrow as pa


LANCEDB_PATH = os.getenv("ABK_VECTOR_DB_PATH", os.path.join(os.path.dirname(__file__), "VectorDB"))

# Must match embedding model output dimension.
# bge-m3 / many cloud embedding models commonly use 1024.
# MiniLM is usually 384.
VECTOR_DIMENSION = int(os.getenv("ABK_VECTOR_DIMENSION", "1024"))

LEGACY_CLASSIFICATION_TABLE = "classification_memory"
MERCHANT_TABLE = "merchant_memory"
CLASSIFICATION_CASE_TABLE = "classification_case_memory"
ADR_TABLE = "adr_memory"
_adr_write_lock = threading.Lock()


def connect_db():
    return lancedb.connect(LANCEDB_PATH)


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def list_table_names(db):
    if hasattr(db, "list_tables"):
        result = db.list_tables()
        if hasattr(result, "tables"):
            return list(result.tables)
        return list(result)

    return list(db.table_names())


def vector_field():
    return pa.field("vector", pa.list_(pa.float32(), VECTOR_DIMENSION))


def merchant_memory_schema():
    return pa.schema([
        pa.field("merchant_record_id", pa.string()),
        pa.field("source_type", pa.string()),
        pa.field("source_id", pa.string()),

        pa.field("raw_shop_name", pa.string()),
        pa.field("normalized_shop_name", pa.string()),
        pa.field("canonical_shop_name", pa.string()),
        pa.field("merchant_type", pa.string()),

        pa.field("status", pa.string()),
        pa.field("confidence", pa.float64()),
        pa.field("user_confirmed", pa.bool_()),

        pa.field("merchant_embedding_text", pa.string()),
        pa.field("embedding_model", pa.string()),
        pa.field("embedding_dimension", pa.int64()),
        vector_field(),

        pa.field("created_at", pa.string()),
        pa.field("updated_at", pa.string()),
        pa.field("extra_json", pa.string()),
    ])


def classification_case_memory_schema():
    return pa.schema([
        pa.field("case_id", pa.string()),

        pa.field("raw_shop_name", pa.string()),
        pa.field("canonical_shop_name", pa.string()),

        pa.field("source_type", pa.string()),
        pa.field("source_id", pa.string()),

        pa.field("amount", pa.float64()),
        pa.field("iso_time", pa.string()),

        pa.field("item_name", pa.string()),
        pa.field("item_type", pa.string()),

        pa.field("main_category", pa.string()),
        pa.field("sub_category", pa.string()),
        pa.field("detail_category", pa.string()),

        pa.field("status", pa.string()),
        pa.field("confidence", pa.float64()),
        pa.field("user_confirmed", pa.bool_()),

        pa.field("semantic_embedding_text", pa.string()),
        pa.field("embedding_model", pa.string()),
        pa.field("embedding_dimension", pa.int64()),
        vector_field(),

        pa.field("created_at", pa.string()),
        pa.field("updated_at", pa.string()),
        pa.field("extra_json", pa.string()),
    ])


def adr_memory_schema():
    return pa.schema([
        pa.field("id", pa.string()),

        pa.field("source_type", pa.string()),   # gmail / mail / ocr / adr_detail
        pa.field("source_id", pa.string()),     # msgid / OCR msgid / ADRDetailID
        pa.field("mail_address", pa.string()),  # sender email address

        pa.field("amount", pa.float64()),
        pa.field("shop_name", pa.string()),
        pa.field("time", pa.string()),

        pa.field("body", pa.string()),          # cleaned mail body / OCR result
        pa.field("mail_subject", pa.string()),
        pa.field("mail_snippet", pa.string()),

        vector_field(),
    ])


def ensure_table(db, table_name, schema):
    if table_name in list_table_names(db):
        table = db.open_table(table_name)
        existing_fields = set(table.schema.names)
        missing_fields = [schema.field(name) for name in schema.names if name not in existing_fields]
        if missing_fields:
            table.add_columns(missing_fields)
            table = db.open_table(table_name)
        return table

    return db.create_table(table_name, schema=schema)


def escape_sql_value(value: str) -> str:
    return str(value).replace("'", "''")


def where_eq(field: str, value: str) -> str:
    return f"{field} = '{escape_sql_value(value)}'"


class LanceMemoryTable:
    def __init__(self, table_name: str, schema: pa.Schema, id_field: str):
        self.db = connect_db()
        self.table_name = table_name
        self.schema = schema
        self.id_field = id_field
        self.table = ensure_table(self.db, table_name, schema)
        self.field_names = set(schema.names)

    def _normalize_row(self, row: dict[str, Any]) -> dict[str, Any]:
        data = {field_name: row.get(field_name) for field_name in self.schema.names}

        if not data.get(self.id_field):
            data[self.id_field] = str(uuid.uuid4())

        if "created_at" in self.field_names and not data.get("created_at"):
            data["created_at"] = now_iso()

        if "updated_at" in self.field_names and not data.get("updated_at"):
            data["updated_at"] = now_iso()

        vector = data.get("vector")
        if vector is None:
            raise ValueError("vector is required")

        if len(vector) != VECTOR_DIMENSION:
            raise ValueError(f"vector dimension must be {VECTOR_DIMENSION}, got {len(vector)}")

        data["vector"] = [float(item) for item in vector]
        return data

    def create(self, row: dict[str, Any]) -> dict[str, Any]:
        if self.table_name == ADR_TABLE:
            return self._create_adr_rows([row])[0]
        data = self._normalize_row(row)
        self.table.add([data])
        return data

    def bulk_create(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.table_name == ADR_TABLE:
            return self._create_adr_rows(rows)
        data = [self._normalize_row(row) for row in rows]
        self.table.add(data)
        return data

    def _create_adr_rows(self, rows):
        created, result, by_source = [], [], {}
        with _adr_write_lock:
            for row in rows:
                source_id = str(row.get("source_id") or "").strip()
                existing = by_source.get(source_id) if source_id else None
                if source_id and existing is None:
                    hits = self.search(where=where_eq("source_id", source_id), limit=1)
                    existing = hits[0] if hits else None
                if existing is not None:
                    result.append({**existing, "_adr_skipped": True})
                    continue
                data = self._normalize_row({**row, "source_id": source_id})
                created.append(data)
                result.append(data)
                if source_id:
                    by_source[source_id] = data
            if created:
                self.table.add(created)
        # Submission happens only after the evidence is committed and visible to matching.
        from adr_events import notify_new_evidence
        for row in created:
            try:
                notify_new_evidence(row)
            except Exception:
                logging.getLogger(__name__).exception("Could not submit ADR evidence id=%s", row["id"])
        return result

    def get(self, record_id: str) -> dict[str, Any] | None:
        rows = self.table.search().where(where_eq(self.id_field, record_id)).limit(1).to_list()
        return rows[0] if rows else None

    def search(
        self,
        vector: list[float] | None = None,
        where: str | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        if vector is not None:
            if len(vector) != VECTOR_DIMENSION:
                raise ValueError(f"vector dimension must be {VECTOR_DIMENSION}, got {len(vector)}")
            query = self.table.search([float(item) for item in vector])
        else:
            query = self.table.search()

        if where:
            query = query.where(where)

        return query.limit(limit).to_list()

    def update(self, record_id: str, values: dict[str, Any]) -> dict[str, Any] | None:
        clean_values = {
            key: value
            for key, value in values.items()
            if key in self.field_names and key != self.id_field
        }

        if "vector" in clean_values:
            vector = clean_values["vector"]
            if len(vector) != VECTOR_DIMENSION:
                raise ValueError(f"vector dimension must be {VECTOR_DIMENSION}, got {len(vector)}")
            clean_values["vector"] = [float(item) for item in vector]

        if "updated_at" in self.field_names:
            clean_values["updated_at"] = now_iso()

        if not clean_values:
            return self.get(record_id)

        self.table.update(
            where=where_eq(self.id_field, record_id),
            values=clean_values,
        )
        return self.get(record_id)

    def delete(self, record_id: str):
        return self.table.delete(where_eq(self.id_field, record_id))

    def count(self) -> int:
        return self.table.count_rows()


def merchant_memory_store() -> LanceMemoryTable:
    return LanceMemoryTable(
        table_name=MERCHANT_TABLE,
        schema=merchant_memory_schema(),
        id_field="merchant_record_id",
    )


def classification_case_memory_store() -> LanceMemoryTable:
    return LanceMemoryTable(
        table_name=CLASSIFICATION_CASE_TABLE,
        schema=classification_case_memory_schema(),
        id_field="case_id",
    )


def adr_memory_store() -> LanceMemoryTable:
    return LanceMemoryTable(
        table_name=ADR_TABLE,
        schema=adr_memory_schema(),
        id_field="id",
    )


def init_vector_db():
    db = connect_db()

    merchant_table = ensure_table(
        db,
        MERCHANT_TABLE,
        merchant_memory_schema(),
    )

    classification_case_table = ensure_table(
        db,
        CLASSIFICATION_CASE_TABLE,
        classification_case_memory_schema(),
    )

    adr_table = ensure_table(
        db,
        ADR_TABLE,
        adr_memory_schema(),
    )

    return {
        "db_path": LANCEDB_PATH,
        "vector_dimension": VECTOR_DIMENSION,
        "tables": list_table_names(db),
        "merchant_schema": str(merchant_table.schema),
        "classification_case_schema": str(classification_case_table.schema),
        "adr_schema": str(adr_table.schema),
    }


if __name__ == "__main__":
    result = init_vector_db()
    print("LanceDB initialized")
    print("db_path:", result["db_path"])
    print("vector_dimension:", result["vector_dimension"])
    print("tables:", result["tables"])
