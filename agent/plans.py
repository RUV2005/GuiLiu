"""Financial plans: confirmation, profile projection and a goal-only money ledger.

Allocations never create income, move money or change a Backend account balance.
The first version supports partial allocations, not whole-account tracking.
"""

import calendar
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import json
import os
from pathlib import Path
import sqlite3
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from service_auth import backend_requests as requests

from agent_database import agent_database_path
from runtime_settings import backend_url


JST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parent
PLAN_GUIDANCE = (
    'For saved savings/investment goals, use get_financial_plans and get_financial_plan for current terms and progress; '
    'The default list includes active, paused and completed plans, excluding archived/deleted plans. '
    'Follow has_more with offset to read all current plans; select status=archived only when requested. '
    'a profile summary or old conversation is not the current balance. Distinguish user-reported allocations, '
    'linked transaction snapshots and hypothetical forecasts. Never treat a plan contribution as a bank transfer, '
    'income or a trade. Plan changes require the financial-plans confirmation UI; do not change a plan through '
    'the ordinary user-profile extraction tool. When a referenced plan is deleted, do not recreate it from memory.'
)


def now():
    return datetime.now(timezone.utc).isoformat()


def today():
    return datetime.now(JST).date()


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True)


def plan_currency(value):
    # Backend accounts use CNY; plans use RMB for the same currency.
    return 'RMB' if value == 'CNY' else value


def money(value, currency):
    amount = Decimal(str(value))
    quantum = Decimal('1') if currency == 'JPY' else Decimal('0.01')
    if not amount.is_finite() or abs(amount) > Decimal('1000000000000') or amount != amount.quantize(quantum):
        raise PlanError('Invalid money precision or amount', 422)
    return amount


def display(value, currency):
    quantum = Decimal('1') if currency == 'JPY' else Decimal('0.01')
    return format(value.quantize(quantum, rounding=ROUND_HALF_UP), 'f')


def month_end(day):
    return day.replace(day=calendar.monthrange(day.year, day.month)[1])


def next_month(day):
    return date(day.year + day.month // 12, day.month % 12 + 1, 1)


class PlanError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True, allow_inf_nan=False)


class PlanData(StrictModel):
    title: str = Field(min_length=1, max_length=120)
    type: Literal['saving', 'investment']
    description: str = Field(default='', max_length=2000)
    currency: Literal['JPY', 'RMB']
    target_amount: Decimal | None = Field(default=None, gt=0, le=1000000000000)
    opening_amount: Decimal = Field(default=0, ge=0, le=1000000000000)
    contribution_amount: Decimal = Field(default=0, ge=0, le=1000000000000)
    frequency: Literal['monthly'] = 'monthly'
    start_date: date
    end_date: date | None = None
    spending_reduces_progress: bool = True

    @field_validator('currency', mode='before')
    @classmethod
    def normalize_currency(cls, value):
        return plan_currency(value)

    @model_validator(mode='after')
    def check_plan(self):
        if not 1900 <= self.start_date.year <= 2100 or (self.end_date and not self.start_date <= self.end_date <= date(2100, 12, 31)):
            raise ValueError('Invalid plan dates')
        if self.target_amount is None and self.contribution_amount == 0:
            raise ValueError('Set a target amount or a positive monthly contribution')
        for value in (self.target_amount, self.opening_amount, self.contribution_amount):
            if value is not None:
                money(value, self.currency)
        return self


class PrepareRequest(StrictModel):
    prompt: str = Field(default='', max_length=8000)
    fields: dict = Field(default_factory=dict)
    plan_id: str | None = None

    @model_validator(mode='after')
    def check_fields(self):
        if not self.prompt and not self.fields:
            raise ValueError('Provide prompt or fields')
        if not set(self.fields) <= set(PlanData.model_fields):
            raise ValueError('Unknown plan fields')
        if len(encode(self.fields)) > 12000:
            raise ValueError('Plan fields are too large')
        return self


class CommitRequest(StrictModel):
    draft_id: str


class PlanUpdate(StrictModel):
    expected_version: int = Field(ge=1)
    draft_id: str | None = None
    status: Literal['active', 'paused', 'completed', 'archived'] | None = None

    @model_validator(mode='after')
    def nonempty(self):
        if self.draft_id is None and self.status is None:
            raise ValueError('Provide draft_id or status')
        return self


class AccountSelection(StrictModel):
    expected_version: int = Field(ge=1)
    account_numbers: list[int] = Field(max_length=20)
    mode: Literal['partial'] = 'partial'

    @field_validator('account_numbers')
    @classmethod
    def unique_accounts(cls, value):
        if any(number <= 0 for number in value) or len(set(value)) != len(value):
            raise ValueError('Account numbers must be positive and unique')
        return value


class EntryRequest(StrictModel):
    expected_version: int = Field(ge=1)
    type: Literal['contribution', 'withdrawal', 'spending']
    amount: Decimal = Field(gt=0, le=1000000000000)
    date: date
    account_number: int | None = Field(default=None, gt=0)
    change_id: int | None = Field(default=None, gt=0)
    note: str = Field(default='', max_length=1000)

    @model_validator(mode='after')
    def linked_source(self):
        if self.change_id is not None and self.account_number is None:
            raise ValueError('A linked transaction requires account_number')
        if self.date > today():
            raise ValueError('Future entries are not actual contributions')
        return self


class ForecastRequest(StrictModel):
    contribution_amount: Decimal | None = Field(default=None, ge=0, le=1000000000000)
    target_amount: Decimal | None = Field(default=None, gt=0, le=1000000000000)
    end_date: date | None = None
    annual_growth_rate: Decimal = Field(default=0, gt=-1, le=1)
    months: int = Field(default=60, ge=1, le=600)


def request_plan_draft(payload):
    # No ReAct loop, conversation history, browsing or financial write tools.
    from agent import ReActAgent
    from model_config import resolve_chat_model
    from tool import open_prompt
    agent = ReActAgent([], resolve_chat_model(), str(ROOT))
    try:
        result = agent.call_model({'messages': [
            {'role': 'system', 'content': open_prompt('financial_plan')},
            {'role': 'user', 'content': encode(payload)}], 'max_output_tokens': 4096})
        value = json.loads(result.strip())
        if not isinstance(value, dict) or set(value) != {'fields', 'profile_summary', 'questions'}:
            raise ValueError('Unexpected draft structure')
        if not isinstance(value['fields'], dict) or not set(value['fields']) <= set(PlanData.model_fields):
            raise ValueError('Unexpected draft fields')
        if not isinstance(value['profile_summary'], str) or not 1 <= len(value['profile_summary']) <= 900:
            raise ValueError('Invalid profile summary')
        if not isinstance(value['questions'], list) or len(value['questions']) > 12 or any(
                not isinstance(item, str) or not 1 <= len(item) <= 500 for item in value['questions']):
            raise ValueError('Invalid clarification questions')
        return value
    except Exception as error:
        raise PlanError('Plan Agent did not return a valid draft; nothing was saved', 502) from error


def backend_get(path, params=None):
    try:
        response = requests.get(backend_url() + path, params=params, timeout=10)
        response.raise_for_status()
        result = response.json()
        if not result.get('success'):
            raise ValueError('Unsuccessful Backend response')
        return result['result']
    except (requests.RequestException, ValueError, KeyError) as error:
        raise PlanError('Account data is unavailable; no allocation was saved', 503) from error


def progress(config, entries, as_of=None):
    day = as_of or today()
    start = date.fromisoformat(config['start_date'])
    code = config['currency']
    balance = Decimal(config['opening_amount']) if day >= start else Decimal(0)
    spent = contributed = Decimal(0)
    for entry in entries:
        entry_day = date.fromisoformat(entry['date'])
        if entry_day > day:
            continue
        amount = Decimal(entry['amount'])
        if entry['type'] == 'contribution':
            balance += amount
        else:
            balance -= amount
        if entry['type'] == 'spending':
            spent += amount
        if entry_day.year == day.year and entry_day.month == day.month and entry['type'] != 'spending':
            contributed += amount if entry['type'] == 'contribution' else -amount
    saved = balance if config['spending_reduces_progress'] else balance + spent
    end = date.fromisoformat(config['end_date']) if config.get('end_date') else day
    cutoff = min(day, end)
    periods = max(0, (cutoff.year - start.year) * 12 + cutoff.month - start.month + (cutoff == month_end(cutoff))) if cutoff >= start else 0
    expected = (Decimal(config['opening_amount']) + Decimal(config['contribution_amount']) * periods) if day >= start else Decimal(0)
    target = Decimal(config['target_amount']) if config.get('target_amount') else None
    return {'as_of': day.isoformat(), 'currency': code, 'current_amount': display(saved, code),
            'available_amount': display(balance, code), 'total_spent': display(spent, code),
            'progress_percent': float(min(Decimal(100), max(Decimal(0), saved / target * 100))) if target else None,
            'remaining_amount': display(max(Decimal(0), target - saved), code) if target else None,
            'period_contributed': display(contributed, code), 'expected_amount': display(expected, code),
            'gap_amount': display(saved - expected, code)}


def forecast(config, entries, scenario=None, status='active'):
    scenario = scenario or ForecastRequest()
    code = config['currency']
    monthly = money(scenario.contribution_amount if scenario.contribution_amount is not None else config['contribution_amount'], code)
    target = money(scenario.target_amount or config['target_amount'], code) if scenario.target_amount or config.get('target_amount') else None
    cutoff = scenario.end_date or (date.fromisoformat(config['end_date']) if config.get('end_date') else None)
    day = today()
    start = date.fromisoformat(config['start_date'])
    current = progress(config, entries, day)
    value = Decimal(current['current_amount'])
    rate = (Decimal(1) + scenario.annual_growth_rate) ** (Decimal(1) / Decimal(12)) - 1
    series = [{'date': day.isoformat(), 'amount': display(value, code)}]
    completion = day if target and value >= target else None
    if start > day:
        value = Decimal(config['opening_amount'])
        series.append({'date': start.isoformat(), 'amount': display(value, code)})
        if target and value >= target:
            completion = start
    cursor = month_end(max(day, start))
    if cursor == day:
        cursor = month_end(next_month(day))
    # Current month's recorded net contributions are not projected a second time.
    for index in range(scenario.months):
        planned = monthly if status == 'active' else Decimal(0)
        if cursor.year == day.year and cursor.month == day.month:
            planned = max(Decimal(0), planned - Decimal(current['period_contributed']))
        if cutoff and cursor > cutoff:
            break
        value = value * (1 + rate) + planned
        if abs(value) > Decimal('1000000000000000000000000'):
            break
        series.append({'date': cursor.isoformat(), 'amount': display(value, code)})
        if completion is None and target and value >= target:
            completion = cursor
        cursor = month_end(next_month(cursor))
    covered = cutoff is not None and (cursor > cutoff or cutoff <= day)
    outlook = 'complete' if target and Decimal(current['current_amount']) >= target else 'unknown'
    if outlook != 'complete' and target and cutoff:
        if completion:
            outlook = 'ahead' if completion < cutoff else 'on_track'
        elif covered:
            outlook = 'at_risk'
    return {'currency': code, 'series': series, 'projected_completion_date': completion.isoformat() if completion else None,
            'outlook': outlook, 'horizon_complete': covered, 'simulation': True,
            'assumptions': {'annual_growth_rate': str(scenario.annual_growth_rate), 'contribution_amount': str(monthly),
                            'timing': 'calendar_month_end', 'growth': 'monthly_compound',
                            'note': 'Projection only; no trades, transfers or guaranteed returns.'}}


class PlanStore:
    def __init__(self, path=None, profile_path=None, fetch=None):
        self.path = Path(path) if path else agent_database_path()
        self.profile_path = Path(profile_path) if profile_path else Path(os.getenv('ABK_CONTEXT_DIR') or ROOT / 'context_store') / 'user_profile.json'
        self.fetch = fetch or backend_get

    @contextmanager
    def connection(self, write=False):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS FinancialPlan (
                    id TEXT PRIMARY KEY, config TEXT NOT NULL, summary TEXT NOT NULL,
                    original_prompt TEXT NOT NULL, accounts TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, deleted_at TEXT, profile_version INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS FinancialPlanDraft (
                    id TEXT PRIMARY KEY, plan_id TEXT, base_version INTEGER, payload TEXT NOT NULL,
                    expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS FinancialPlanEntry (
                    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES FinancialPlan(id),
                    payload TEXT NOT NULL, source_key TEXT, deleted_at TEXT);
                CREATE UNIQUE INDEX IF NOT EXISTS financial_plan_entry_source ON FinancialPlanEntry(source_key)
                    WHERE source_key IS NOT NULL AND deleted_at IS NULL;
                CREATE INDEX IF NOT EXISTS financial_plan_entries ON FinancialPlanEntry(plan_id);
                CREATE TABLE IF NOT EXISTS FinancialPlanOperation (
                    key TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL);
            ''')
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def row(self, db, ident, version=None):
        row = db.execute('SELECT * FROM FinancialPlan WHERE id=? AND deleted_at IS NULL', (ident,)).fetchone()
        if row is None:
            raise PlanError('Plan not found', 404)
        if version is not None and row['version'] != version:
            raise PlanError('Plan changed; refresh before editing', 409)
        return row

    def entries(self, db, ident):
        rows = db.execute('SELECT payload FROM FinancialPlanEntry WHERE plan_id=? AND deleted_at IS NULL', (ident,))
        return sorted((json.loads(row[0]) for row in rows), key=lambda entry: (entry['date'], entry['id']))

    def mutate(self, key, kind, payload, callback):
        signature = encode({'kind': kind, 'payload': payload})
        with self.connection(True) as db:
            old = db.execute('SELECT * FROM FinancialPlanOperation WHERE key=?', (key,)).fetchone()
            if old:
                if old['signature'] != signature:
                    raise PlanError('Idempotency-Key already used with another request', 409)
                result = json.loads(old['result'])
            else:
                result = callback(db)
                db.execute('INSERT INTO FinancialPlanOperation VALUES (?,?,?)', (key, signature, encode(result)))
        result['profile_sync'] = self.sync_profile()
        return result

    def replay(self, key, kind, payload):
        # Retry already committed operations without requiring the Backend to be online.
        with self.connection() as db:
            old = db.execute('SELECT * FROM FinancialPlanOperation WHERE key=?', (key,)).fetchone()
            if old is None:
                return None
            if old['signature'] != encode({'kind': kind, 'payload': payload}):
                raise PlanError('Idempotency-Key already used with another request', 409)
            result = json.loads(old['result'])
        result['profile_sync'] = self.sync_profile()
        return result

    def sync_profile(self):
        # The plan table is authoritative. Failed file writes remain pending and are retried.
        from user_profile import _locked, _load, _save
        try:
            with self.connection(True) as db:
                rows = db.execute('SELECT * FROM FinancialPlan WHERE profile_version != version').fetchall()
                if not rows:
                    return 'synced'
                with _locked(self.profile_path):
                    profile = _load(self.profile_path)
                    for row in rows:
                        key = 'plan.' + row['id']
                        if row['deleted_at'] or row['status'] == 'archived':
                            profile['entries'].pop(key, None)
                        else:
                            config = json.loads(row['config'])
                            profile['entries'][key] = {'category': 'goal',
                                'value': '[' + row['status'] + '] ' + row['summary'],
                                'source': {'plan_id': row['id'], 'version': row['version'],
                                           'quote': encode(config), 'created_at': row['updated_at']}}
                    profile['revision'] += 1
                    profile['updated_at'] = now()
                    _save(profile, self.profile_path)
                db.execute('UPDATE FinancialPlan SET profile_version=version WHERE profile_version != version')
            return 'synced'
        except (OSError, ValueError, sqlite3.Error):
            return 'pending'

    def prepare(self, request, runner=None):
        current = None
        if request.plan_id:
            with self.connection() as db:
                current = dict(self.row(db, request.plan_id))
        proposed = (runner or request_plan_draft)({'today': today().isoformat(), 'timezone': 'Asia/Tokyo',
            'prompt': request.prompt, 'fields': request.fields,
            'current_plan': json.loads(current['config']) if current else None,
            'schema': PlanData.model_json_schema()})
        fields = {**(json.loads(current['config']) if current else {}), **proposed['fields'], **request.fields}
        questions = list(proposed['questions'])
        try:
            fields = PlanData.model_validate(fields).model_dump(mode='json')
        except (ValidationError, PlanError) as error:
            if isinstance(error, ValidationError):
                questions.extend('.'.join(str(part) for part in item['loc']) + ': ' + item['msg'] for item in error.errors())
            else:
                questions.append(str(error))
        payload = {'fields': fields, 'profile_summary': proposed['profile_summary'], 'questions': questions,
                   'ready': not questions, 'original_prompt': request.prompt}
        ident = uuid4().hex
        expires = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
        with self.connection(True) as db:
            db.execute('DELETE FROM FinancialPlanDraft WHERE expires_at < ?', (now(),))
            db.execute('INSERT INTO FinancialPlanDraft VALUES (?,?,?,?,?,0)',
                       (ident, request.plan_id, current['version'] if current else None, encode(payload), expires))
        return {'draft_id': ident, 'plan_id': request.plan_id, 'base_version': current['version'] if current else None,
                'expires_at': expires, **payload}

    def draft(self, db, ident, plan_id=None, version=None):
        row = db.execute('SELECT * FROM FinancialPlanDraft WHERE id=?', (ident,)).fetchone()
        if row is None or row['expires_at'] < now():
            raise PlanError('Draft missing or expired; prepare again', 409)
        payload = json.loads(row['payload'])
        if row['consumed'] or row['plan_id'] != plan_id or row['base_version'] != version or not payload['ready']:
            raise PlanError('Draft not ready, already used, or based on another version', 409)
        PlanData.model_validate(payload['fields'])
        db.execute('UPDATE FinancialPlanDraft SET consumed=1 WHERE id=?', (ident,))
        return payload

    def create(self, request, key):
        def action(db):
            draft = self.draft(db, request.draft_id)
            ident, timestamp = uuid4().hex, now()
            db.execute('''INSERT INTO FinancialPlan
                (id,config,summary,original_prompt,status,version,created_at,updated_at)
                VALUES (?,?,?,?,'active',1,?,?)''',
                (ident, encode(draft['fields']), draft['profile_summary'], draft['original_prompt'], timestamp, timestamp))
            return {'id': ident, 'version': 1}
        return self.mutate(key, 'create', request.model_dump(), action)

    def update(self, ident, request, key):
        def action(db):
            row = self.row(db, ident, request.expected_version)
            config, summary, prompt = row['config'], row['summary'], row['original_prompt']
            entries = self.entries(db, ident)
            if request.draft_id:
                draft = self.draft(db, request.draft_id, ident, row['version'])
                before, after = json.loads(config), draft['fields']
                if (entries or json.loads(row['accounts'])) and before['currency'] != after['currency']:
                    raise PlanError('Clear entries and account links before changing currency', 409)
                if any(entry['date'] < after['start_date'] for entry in entries):
                    raise PlanError('Start date would exclude existing entries', 409)
                self.validate_balances(after, entries)
                config, summary, prompt = encode(after), draft['profile_summary'], draft['original_prompt']
            if row['status'] == 'archived' and request.status and request.status != 'archived':
                self.check_reallocation(db, entries, [])
            db.execute('UPDATE FinancialPlan SET config=?,summary=?,original_prompt=?,status=?,version=version+1,updated_at=? WHERE id=?',
                       (config, summary, prompt, request.status or row['status'], now(), ident))
            return {'id': ident, 'version': row['version'] + 1}
        return self.mutate(key, 'update:' + ident, request.model_dump(), action)

    def delete(self, ident, version, key):
        def action(db):
            row = self.row(db, ident, version)
            db.execute('UPDATE FinancialPlan SET deleted_at=?,updated_at=?,version=version+1 WHERE id=?', (now(), now(), ident))
            db.execute('UPDATE FinancialPlanEntry SET deleted_at=? WHERE plan_id=? AND deleted_at IS NULL', (now(), ident))
            return {'id': ident, 'deleted': True, 'version': row['version'] + 1}
        return self.mutate(key, 'delete:' + ident, {'version': version}, action)

    def output(self, db, row, detail=False):
        config, entries = json.loads(row['config']), self.entries(db, row['id'])
        result = {'id': row['id'], **config, 'status': row['status'], 'version': row['version'],
                  'profile_summary': row['summary'], 'account_numbers': json.loads(row['accounts']),
                  'created_at': row['created_at'], 'updated_at': row['updated_at'],
                  'progress': progress(config, entries),
                  'profile_sync': 'synced' if row['profile_version'] == row['version'] else 'pending'}
        if detail:
            result.update(recent_entries=entries[-20:][::-1], forecast=forecast(config, entries, status=row['status']))
        if row['status'] == 'archived':
            result['progress']['available_amount'] = display(Decimal(0), config['currency'])
        return result

    def list(self, status=None, limit=50, offset=0):
        self.sync_profile()
        with self.connection() as db:
            where, args = 'deleted_at IS NULL', []
            if status:
                where += ' AND status=?'
                args.append(status)
            else:
                where += " AND status != 'archived'"
            total = db.execute('SELECT COUNT(*) FROM FinancialPlan WHERE ' + where, args).fetchone()[0]
            rows = db.execute('SELECT * FROM FinancialPlan WHERE ' + where + ' ORDER BY created_at DESC,id LIMIT ? OFFSET ?', [*args, limit, offset])
            return {'items': [self.output(db, row) for row in rows], 'total': total, 'limit': limit, 'offset': offset}

    def detail(self, ident):
        self.sync_profile()
        with self.connection() as db:
            return self.output(db, self.row(db, ident), True)

    def allocated(self, db, number):
        total = Decimal(0)
        for row in db.execute('''SELECT e.payload FROM FinancialPlanEntry e JOIN FinancialPlan p ON p.id=e.plan_id
                WHERE e.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status != 'archived' '''):
            entry = json.loads(row[0])
            if entry['account_number'] == number:
                total += Decimal(entry['amount']) * (1 if entry['type'] == 'contribution' else -1)
        return total

    def accounts(self):
        accounts = self.fetch('/DB/accounts')['items']
        with self.connection() as db:
            result = []
            for account in accounts:
                if account['account_type'] == 'credit' or account.get('balance') is None:
                    continue
                code, number = account['currency'], account['account_number']
                allocated = self.allocated(db, number)
                available = Decimal(account['balance']) - allocated
                result.append({**account, 'allocated_amount': display(allocated, code),
                               'available_amount': display(max(Decimal(0), available), code), 'over_allocated': available < 0})
            return {'items': result, 'as_of': now(), 'supported_modes': ['partial']}

    def select_accounts(self, ident, request, key):
        replay = self.replay(key, 'accounts:' + ident, request.model_dump())
        if replay is not None:
            return replay
        available = {row['account_number']: row for row in self.accounts()['items']}
        def action(db):
            row = self.row(db, ident, request.expected_version)
            config = json.loads(row['config'])
            for number in request.account_numbers:
                if number not in available or plan_currency(available[number]['currency']) != config['currency']:
                    raise PlanError('Use a non-credit account in the same currency', 422)
            used = {entry['account_number'] for entry in self.entries(db, ident) if entry['account_number'] is not None}
            if not used <= set(request.account_numbers):
                raise PlanError('Account has allocation history; remove its entries first', 409)
            db.execute('UPDATE FinancialPlan SET accounts=?,version=version+1,updated_at=? WHERE id=?',
                       (encode(request.account_numbers), now(), ident))
            return {'id': ident, 'version': row['version'] + 1, 'account_numbers': request.account_numbers}
        return self.mutate(key, 'accounts:' + ident, request.model_dump(), action)

    def source_entry(self, request):
        if request.change_id is None:
            return None
        # Backend currently exposes paginated changes rather than a single-change endpoint.
        changes, complete = [], False
        for offset in range(0, 2000, 100):
            page = self.fetch(f'/DB/accounts/{request.account_number}/changes', {'limit': 100, 'offset': offset})
            changes.extend(page['items'])
            if not page.get('has_more'):
                complete = True
                break
        if not complete:
            raise PlanError('Too many account changes to verify reversals; use a manual entry', 422)
        for row in changes:
            if row['change_id'] != request.change_id:
                continue
            expected_type = {'income': 'contribution', 'expense': 'spending'}.get(row['change_type'])
            if expected_type != request.type:
                raise PlanError('Only income/contribution and expense/spending links are supported', 422)
            amount = abs(Decimal(row['amount']))
            effective = datetime.fromisoformat(row['effective_at']).astimezone(JST).date()
            if amount != request.amount or effective != request.date:
                raise PlanError('Linked amount/date must match the original transaction', 422)
            if any(item.get('reverses_change_id') == request.change_id for item in changes):
                raise PlanError('Cannot link a reversed transaction', 409)
            return row
        raise PlanError('Transaction not found', 404)

    def check_reallocation(self, db, after, before):
        deltas = {}
        for entries, factor in ((after, 1), (before, -1)):
            for entry in entries:
                number = entry['account_number']
                if number is not None:
                    delta = Decimal(entry['amount']) * (1 if entry['type'] == 'contribution' else -1)
                    deltas[number] = deltas.get(number, Decimal(0)) + factor * delta
        for number, increase in deltas.items():
            if increase <= 0:
                continue
            account = self.fetch(f'/DB/accounts/{number}')
            if account.get('balance') is None or self.allocated(db, number) + increase > Decimal(account['balance']):
                raise PlanError('Restoring these allocations would exceed the account balance', 409)

    def validate_balances(self, config, entries):
        balance = Decimal(config['opening_amount'])
        accounts = {}
        for entry in sorted(entries, key=lambda value: (value['date'], value['type'] != 'contribution', value['id'])):
            delta = Decimal(entry['amount']) * (1 if entry['type'] == 'contribution' else -1)
            balance += delta
            number = entry['account_number']
            if number is not None:
                accounts[number] = accounts.get(number, Decimal(0)) + delta
            if balance < 0 or any(value < 0 for value in accounts.values()):
                raise PlanError('Withdrawal/spending exceeds allocated funds on that date', 409)

    def add_entry(self, ident, request, key):
        replay = self.replay(key, 'entry:' + ident, request.model_dump(mode='json'))
        if replay is not None:
            return replay
        source = self.source_entry(request)
        account = self.fetch(f'/DB/accounts/{request.account_number}') if request.account_number is not None else None
        def action(db):
            row = self.row(db, ident, request.expected_version)
            config = json.loads(row['config'])
            if row['status'] != 'active':
                raise PlanError('Resume the plan before adding entries', 409)
            if request.date < date.fromisoformat(config['start_date']):
                raise PlanError('Entry precedes plan start', 422)
            amount = money(request.amount, config['currency'])
            if account:
                if request.account_number not in json.loads(row['accounts']) or plan_currency(account['currency']) != config['currency'] or account['account_type'] == 'credit':
                    raise PlanError('Select a same-currency non-credit account first', 422)
                if request.type == 'contribution' and (account.get('balance') is None or amount > Decimal(account['balance']) - self.allocated(db, request.account_number)):
                    raise PlanError('Insufficient unallocated account balance', 409)
            entry_id = uuid4().hex
            entry = {**request.model_dump(mode='json', exclude={'expected_version'}), 'id': entry_id,
                     'amount': display(amount, config['currency']), 'currency': config['currency'], 'created_at': now(), 'source': source}
            self.validate_balances(config, [*self.entries(db, ident), entry])
            source_key = f'account_change:{request.change_id}' if source else None
            if source_key and db.execute('SELECT 1 FROM FinancialPlanEntry WHERE source_key=? AND deleted_at IS NULL', (source_key,)).fetchone():
                raise PlanError('Transaction already linked to a plan', 409)
            db.execute('INSERT INTO FinancialPlanEntry VALUES (?,?,?,?,NULL)', (entry_id, ident, encode(entry), source_key))
            db.execute('UPDATE FinancialPlan SET version=version+1,updated_at=? WHERE id=?', (now(), ident))
            return {'id': ident, 'version': row['version'] + 1, 'entry': entry}
        return self.mutate(key, 'entry:' + ident, request.model_dump(mode='json'), action)

    def remove_entry(self, ident, entry_id, version, key):
        def action(db):
            row = self.row(db, ident, version)
            entries = self.entries(db, ident)
            if not any(entry['id'] == entry_id for entry in entries):
                raise PlanError('Entry not found', 404)
            remaining = [entry for entry in entries if entry['id'] != entry_id]
            self.validate_balances(json.loads(row['config']), remaining)
            if row['status'] != 'archived':
                self.check_reallocation(db, remaining, entries)
            db.execute('UPDATE FinancialPlanEntry SET deleted_at=? WHERE id=? AND plan_id=?', (now(), entry_id, ident))
            db.execute('UPDATE FinancialPlan SET version=version+1,updated_at=? WHERE id=?', (now(), ident))
            return {'id': ident, 'entry_id': entry_id, 'deleted': True, 'version': row['version'] + 1}
        return self.mutate(key, 'entry.delete:' + ident, {'entry_id': entry_id, 'version': version}, action)

    def entry_list(self, ident, limit, offset):
        with self.connection() as db:
            self.row(db, ident)
            entries = self.entries(db, ident)[::-1]
            return {'items': entries[offset:offset + limit], 'total': len(entries), 'limit': limit, 'offset': offset}

    def chart(self, ident, start_date, end_date):
        if end_date < start_date or (end_date - start_date).days > 365 or end_date > today():
            raise PlanError('Use a historical date range of up to 366 days', 422)
        with self.connection() as db:
            row = self.row(db, ident)
            config, entries = json.loads(row['config']), self.entries(db, ident)
            series = [progress(config, entries, start_date + timedelta(days=index)) for index in range((end_date - start_date).days + 1)]
            return {'summary': progress(config, entries), 'series': series,
                    'forecast': forecast(config, entries, status=row['status'])}

    def simulate(self, ident, scenario):
        with self.connection() as db:
            row = self.row(db, ident)
            if scenario.end_date and scenario.end_date < max(today(), date.fromisoformat(json.loads(row['config'])['start_date'])):
                raise PlanError('Forecast end date precedes today or plan start', 422)
            return forecast(json.loads(row['config']), self.entries(db, ident), scenario, row['status'])


def create_plans_router(store=None, runner=None):
    store = store or PlanStore()
    router = APIRouter(prefix='/agent/plans', tags=['Financial plans'])

    def respond(callback, code=200):
        try:
            return JSONResponse({'success': True, 'result': callback(), 'error': None, 'status_code': code}, status_code=code)
        except (PlanError, ValidationError, sqlite3.Error) as error:
            code = error.status if isinstance(error, PlanError) else (422 if isinstance(error, ValidationError) else 503)
            message = 'Plan storage unavailable' if isinstance(error, sqlite3.Error) else str(error)
            return JSONResponse({'success': False, 'result': None, 'error': message, 'status_code': code}, status_code=code)

    @router.post('/prepare')
    def prepare(request: PrepareRequest):
        return respond(lambda: store.prepare(request, runner))

    @router.get('/accounts')
    def accounts():
        return respond(store.accounts)

    @router.get('')
    def list_plans(status: Literal['active', 'paused', 'completed', 'archived'] | None = None,
                   limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
        return respond(lambda: store.list(status, limit, offset))

    @router.post('')
    def create(request: CommitRequest, idempotency_key: str = Header(min_length=1, max_length=200)):
        return respond(lambda: store.create(request, idempotency_key), 201)

    @router.get('/{plan_id}')
    def detail(plan_id: str):
        return respond(lambda: store.detail(plan_id))

    @router.patch('/{plan_id}')
    def update(plan_id: str, request: PlanUpdate, idempotency_key: str = Header(min_length=1, max_length=200)):
        return respond(lambda: store.update(plan_id, request, idempotency_key))

    @router.delete('/{plan_id}')
    def delete(plan_id: str, expected_version: int = Query(ge=1), idempotency_key: str = Header(min_length=1, max_length=200)):
        return respond(lambda: store.delete(plan_id, expected_version, idempotency_key))

    @router.put('/{plan_id}/accounts')
    def select_accounts(plan_id: str, request: AccountSelection, idempotency_key: str = Header(min_length=1, max_length=200)):
        return respond(lambda: store.select_accounts(plan_id, request, idempotency_key))

    @router.post('/{plan_id}/entries')
    def add_entry(plan_id: str, request: EntryRequest, idempotency_key: str = Header(min_length=1, max_length=200)):
        return respond(lambda: store.add_entry(plan_id, request, idempotency_key), 201)

    @router.get('/{plan_id}/entries')
    def entries(plan_id: str, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0)):
        return respond(lambda: store.entry_list(plan_id, limit, offset))

    @router.delete('/{plan_id}/entries/{entry_id}')
    def remove_entry(plan_id: str, entry_id: str, expected_version: int = Query(ge=1), idempotency_key: str = Header(min_length=1, max_length=200)):
        return respond(lambda: store.remove_entry(plan_id, entry_id, expected_version, idempotency_key))

    @router.get('/{plan_id}/progress')
    def chart(plan_id: str, start_date: date, end_date: date):
        return respond(lambda: store.chart(plan_id, start_date, end_date))

    @router.post('/{plan_id}/forecast')
    def simulate(plan_id: str, request: ForecastRequest):
        return respond(lambda: store.simulate(plan_id, request))

    return router


def get_financial_plans(status: str | None = None, limit: int = 20, offset: int = 0):
    """Read saved financial plans and calculated progress. No model calls or account changes.
    status=None includes active/paused/completed, excluding archived/deleted plans.
    Select active/paused/completed/archived explicitly to filter. limit is 1..50; offset starts at 0.
    Follow has_more to read subsequent pages. Plan IDs can be used with get_financial_plan.
    These are savings/investment goals, not automatic tasks or timers.
    """
    try:
        if status is not None and (not isinstance(status, str) or status not in {'active', 'paused', 'completed', 'archived'}):
            raise PlanError('Invalid status', 422)
        if type(limit) is not int or not 1 <= limit <= 50:
            raise PlanError('limit must be an integer between 1 and 50', 422)
        if type(offset) is not int or offset < 0:
            raise PlanError('offset must be a nonnegative integer', 422)
        result = PlanStore().list(status, limit, offset)
        result['has_more'] = result['offset'] + len(result['items']) < result['total']
        return {'success': True, 'result': result, 'error': None}
    except (PlanError, sqlite3.Error) as error:
        return {'success': False, 'result': None, 'error': str(error)}


def get_financial_plan(plan_id: str):
    """Read one saved plan, its recent contributions and deterministic forecast.
    Manual records are user-reported, linked transactions are snapshots; forecasts are assumptions.
    This tool cannot change plan terms, holdings or real account balances.
    """
    try:
        return {'success': True, 'result': PlanStore().detail(plan_id), 'error': None}
    except (PlanError, sqlite3.Error) as error:
        return {'success': False, 'result': None, 'error': str(error)}
