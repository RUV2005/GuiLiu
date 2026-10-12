import datetime
from dataclasses import dataclass
import json
import sqlite3
from typing import Any
from agent_database import initialize_agent_database



@dataclass
class UserConversationCreateData:
    StartTime: str
    EndTime: str
    UserInput: str
    LLMOutput: str
    UsedTool: str
    Results: int


@dataclass
class UserConversationUpdateData:
    UCID: int
    StartTime: str
    EndTime: str
    UserInput: str
    LLMOutput: str
    UsedTool: str
    Results: int


@dataclass
class AgentLogCreateData:
    StartTime: str | None = None
    EndTime: str | None = None
    LLMOutput: str | None = None
    UsedTool: str | None = None
    results: int | None = None
    AFName: str | None = None


@dataclass
class AgentLogUpdateData:
    ALID: int | None = None
    StartTime: str | None = None
    EndTime: str | None = None
    LLMOutput: str | None = None
    UsedTool: str | None = None
    results: int | None = None
    AFName: str | None = None

    # =========================
    # UserConversation 表增删改查
    # 表头:
    # UCID, StartTime, EndTime, UserInput, LLMOutput, UsedTool, Results
class AgentLog:
    def __init__(self, DBname: str | None = None):
        self.DBname = str(initialize_agent_database(DBname))

    def C_for_UserConversation(self, data: UserConversationCreateData):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                INSERT INTO UserConversation (
                    StartTime,
                    EndTime,
                    UserInput,
                    LLMOutput,
                    UsedTool,
                    Results
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    data.StartTime,
                    data.EndTime,
                    data.UserInput,
                    data.LLMOutput,
                    data.UsedTool,
                    data.Results
                )
            )
            conn.commit()
            return cursor.lastrowid

        except Exception as e:
            print(f"Error occurred: {e}")
            return 0

        finally:
            cursor.close()
            conn.close()


    def R_for_UserConversation_by_UCID(self, UCID):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT
                    UCID,
                    StartTime,
                    EndTime,
                    UserInput,
                    LLMOutput,
                    UsedTool,
                    Results
                FROM UserConversation
                WHERE UCID = ?
                """,
                (UCID,)
            )
            row = cursor.fetchone()
            return row

        except Exception as e:
            print(f"Error occurred: {e}")
            return None

        finally:
            cursor.close()
            conn.close()


    def R_for_all_UserConversation(self):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT
                    UCID,
                    StartTime,
                    EndTime,
                    UserInput,
                    LLMOutput,
                    UsedTool,
                    Results
                FROM UserConversation
                ORDER BY UCID DESC
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


    def U_for_UserConversation(self, data: UserConversationUpdateData):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                UPDATE UserConversation
                SET
                    StartTime = ?,
                    EndTime = ?,
                    UserInput = ?,
                    LLMOutput = ?,
                    UsedTool = ?,
                    Result = ?
                WHERE UCID = ?
                """,
                (
                    data.StartTime,
                    data.EndTime,
                    data.UserInput,
                    data.LLMOutput,
                    data.UsedTool,
                    data.Result,
                    data.UCID
                )
            )
            conn.commit()
            return cursor.rowcount

        except Exception as e:
            print(f"Error occurred: {e}")
            return 0

        finally:
            cursor.close()
            conn.close()


    def D_for_UserConversation(self, UCID):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                DELETE FROM UserConversation
                WHERE UCID = ?
                """,
                (UCID,)
            )
            conn.commit()
            return cursor.rowcount

        except Exception as e:
            print(f"Error occurred: {e}")
            return 0

        finally:
            cursor.close()
            conn.close()


    # =========================
    # AgentLog 表增删改查
    # 表头:
    # ALID, StartTime, EndTime, LLMOutput, UsedTool, results
    # =========================

    def C_for_AgentLog(self, data: AgentLogCreateData):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                INSERT INTO AgentLog (
                    StartTime,
                    EndTime,
                    LLMOutput,
                    UsedTool,
                    results,
                    AFName
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    data.StartTime,
                    data.EndTime,
                    data.LLMOutput,
                    data.UsedTool,
                    data.results,
                    data.AFName
                )
            )
            conn.commit()
            return cursor.lastrowid

        except Exception as e:
            print(f"Error occurred: {e}")
            return 0

        finally:
            cursor.close()
            conn.close()


    def R_for_AgentLog_by_ALID(self, ALID):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT
                    ALID,
                    StartTime,
                    EndTime,
                    LLMOutput,
                    UsedTool,
                    results,
                    AFName
                FROM AgentLog
                WHERE ALID = ?
                """,
                (ALID,)
            )
            row = cursor.fetchone()
            return row

        except Exception as e:
            print(f"Error occurred: {e}")
            return None

        finally:
            cursor.close()
            conn.close()


    def R_for_all_AgentLog(self):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                SELECT
                    ALID,
                    StartTime,
                    EndTime,
                    LLMOutput,
                    UsedTool,
                    results,
                    AFName
                FROM AgentLog
                ORDER BY ALID DESC
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


    def U_for_AgentLog(self, data: AgentLogUpdateData):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                UPDATE AgentLog
                SET
                    StartTime = ?,
                    EndTime = ?,
                    LLMOutput = ?,
                    UsedTool = ?,
                    results = ?,
                    AFName = ?
                WHERE ALID = ?
                """,
                (
                    data.StartTime,
                    data.EndTime,
                    data.LLMOutput,
                    data.UsedTool,
                    data.results,
                    data.AFName,
                    data.ALID
                )
            )
            conn.commit()
            return cursor.rowcount

        except Exception as e:
            print(f"Error occurred: {e}")
            return 0

        finally:
            cursor.close()
            conn.close()


    def D_for_AgentLog(self, ALID):
        conn = sqlite3.connect(self.DBname)
        cursor = conn.cursor()

        try:
            cursor.execute(
                """
                DELETE FROM AgentLog
                WHERE ALID = ?
                """,
                (ALID,)
            )
            conn.commit()
            return cursor.rowcount

        except Exception as e:
            print(f"Error occurred: {e}")
            return 0

        finally:
            cursor.close()
            conn.close()

    def now_iso(self):
        return datetime.datetime.now().astimezone().isoformat()

    def start_user_conversation(self, user_input: str):
        return [self.now_iso(), user_input or ""]


    def finish_user_conversation(self, log_list, llm_output: str, used_tool, results: int):
        start_time = log_list[0]
        user_input = log_list[1]

        if isinstance(used_tool, list):
            used_tool_text = json.dumps(used_tool, ensure_ascii=False)
        else:
            used_tool_text = str(used_tool or "[]")

        data = UserConversationCreateData(
            StartTime=start_time,
            EndTime=self.now_iso(),
            UserInput=user_input,
            LLMOutput=llm_output or "",
            UsedTool=used_tool_text,
            Results=results,
        )

        return self.C_for_UserConversation(data)

    def start_agent_log(self, agent_function_name: str):
        return [self.now_iso(), agent_function_name]


    def finish_agent_log(self, log_list, llm_output: str = "", used_tool: str = "", results: int = 1):
        start_time = log_list[0]
        AFName = log_list[1] if len(log_list) > 1 else None

        final_llm_output = llm_output
        final_used_tool = used_tool

        if isinstance(final_used_tool, list):
            final_used_tool = json.dumps(final_used_tool, ensure_ascii=False)
        else:
            final_used_tool = str(final_used_tool or "")

        data = AgentLogCreateData(
            StartTime=start_time,
            EndTime=self.now_iso(),
            LLMOutput=final_llm_output,
            UsedTool=final_used_tool,
            results=results,
            AFName=AFName
        )

        return self.C_for_AgentLog(data)

    def collect_tool_names(self,tools, previous_tools_str: str = "") -> str:
        result = []

        def walk(item):
            if item is None:
                return

            # 函数对象
            if callable(item):
                result.append(getattr(item, "__name__", str(item)))
                return

            # 字符串
            if isinstance(item, str):
                result.append(item)
                return

            # 字典
            if isinstance(item, dict):
                for value in item.values():
                    walk(value)
                return

            # list / tuple / set
            if isinstance(item, (list, tuple, set)):
                for sub_item in item:
                    walk(sub_item)
                return

            # 其他类型
            result.append(str(item))

        # 先解析旧值
        merged_result = []

        if previous_tools_str:
            try:
                old_tools = json.loads(previous_tools_str)
                if isinstance(old_tools, list):
                    merged_result.extend([str(x) for x in old_tools])
                else:
                    merged_result.append(str(old_tools))
            except Exception:
                # 如果旧值不是合法 JSON，就按普通字符串处理
                merged_result.append(previous_tools_str)

        # 再递归解析新值
        walk(tools)
        merged_result.extend(result)

        # 去重但保留顺序
        unique_result = []
        seen = set()
        for name in merged_result:
            if name not in seen:
                seen.add(name)
                unique_result.append(name)

        return json.dumps(unique_result, ensure_ascii=False)
