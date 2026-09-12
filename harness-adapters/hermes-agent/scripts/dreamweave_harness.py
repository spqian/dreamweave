#!/usr/bin/env python3
"""Checkpointed transport/validation for caller-LLM judgment, never a judge."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
try:
    import fcntl
except ImportError:  # Keep --help and a clear unsupported-platform error usable.
    fcntl = None
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import uuid

SURFACES = ('entities', 'aliases', 'salience', 'merges', 'synthesis', 'chronicles')


class Refused(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise Refused(message)


def require_supported_platform():
    require(sys.platform in ('linux', 'darwin') and fcntl is not None,
            'unsupported platform: this adapter requires Linux/macOS fcntl.flock; Windows is not supported')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def atomic_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    with tmp.open('w', encoding='utf-8') as f:
        os.chmod(tmp, 0o600)
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def review_keys(report):
    lanes = {'entities': [('facts', 'sig'), ('hubs', 'sig')],
             'aliases': [('hubs', 'sig')], 'salience': [('facts', 'sig'), ('review', 'sig')],
             'merges': [('clusters', None)], 'synthesis': [('pools', 'poolId'), ('reactivation_pools', 'poolId')],
             'chronicles': [('candidates', 'periodId')]}
    require(isinstance(report, dict) and report.get('surface') in lanes, 'unknown report schema')
    keys = []
    for lane, field in lanes[report['surface']]:
        require(isinstance(report.get(lane), list), f'report missing {lane} array')
        for i, item in enumerate(report[lane]):
            key = str(i) if field is None else item.get(field)
            require(isinstance(key, str) and key, 'report item lacks identity')
            keys.append(f'{lane}:{key}')
    require(len(keys) == len(set(keys)), 'report has duplicate item identities')
    return keys


def shape(value, required, optional=()):
    require(isinstance(value, dict) and set(required) <= set(value) <= set(required) | set(optional),
            f'malformed schema: expected {required}, optional {optional}')


def text(value, minimum=1):
    require(isinstance(value, str) and len(value.strip()) >= minimum, 'missing/short text')


def strings(value, minimum=0):
    require(isinstance(value, list) and all(isinstance(x, str) and x.strip() for x in value), 'expected string array')
    require(len(value) >= minimum and len(value) == len(set(value)), 'too few or duplicate strings')
    return set(value)


def entity(sig, kind, forms):
    import re
    require(kind in ('person', 'org', 'team', 'place', 'project', 'system', 'topic'), 'invalid entity type')
    require(isinstance(sig, str) and len(sig) <= 80 and re.fullmatch(re.escape(kind) + r':[a-z0-9][a-z0-9-]+', sig), 'invalid entity sig')
    strings(forms, minimum=1)
    require(all(len(f) >= 3 and f == f.lower() and f == f.strip() for f in forms), 'invalid entity forms')


def validate_payload(report, payload, audit=None):
    surface = report['surface']
    deferred_keys = {r['key'] for r in (audit or {}).get('reviews', []) if r.get('outcome') == 'defer'}
    if surface == 'aliases':
        require(isinstance(payload, list), 'aliases payload must be a bare array')
        valid = {h['sig'] for h in report['hubs']}
        claimed = set()
        for group in payload:
            shape(group, ('canonical', 'aliases'))
            members = strings(group['aliases'], minimum=1)
            text(group['canonical'])
            members.add(group['canonical'])
            require(group['canonical'] not in group['aliases'] and members <= valid and not members & claimed,
                    'invalid/overlapping alias group or invented sig')
            claimed.update(members)
        require(not deferred_keys & {'hubs:' + sig for sig in claimed},
                'deferred alias hubs must not be mutated, including canonical targets')
        return
    fields = {'entities': ('report_id', 'decisions', 'hub_reviews'),
              'salience': ('salient', 'downgrade'), 'merges': ('report_id', 'decisions'),
              'synthesis': ('report_id', 'decisions', 'reactivation_reviews'),
              'chronicles': ('report_id', 'decisions')}[surface]
    shape(payload, fields)
    for field in fields:
        if field == 'report_id':
            require(isinstance(payload[field], str) and payload[field] == report.get(field), 'payload report_id stale or missing')
        else:
            require(isinstance(payload[field], list), f'{field} must be an array')
    if surface == 'entities':
        seen = set()
        for item in payload['decisions']:
            shape(item, ('sig', 'type', 'forms'))
            entity(item['sig'], item['type'], item['forms'])
            require(item['sig'] not in seen, 'duplicate entity decision')
            seen.add(item['sig'])
        hubs = {h['sig']: h for h in report['hubs']}
        seen = set()
        for item in payload['hub_reviews']:
            shape(item, ('sig', 'action'), ('type', 'new_sig', 'forms'))
            sig, action = item['sig'], item['action']
            require(isinstance(sig, str) and sig in hubs and sig not in seen, 'unknown/duplicate hub review')
            seen.add(sig)
            require(action in ('keep', 'reject', 'retype', 'remove_forms'), 'invalid hub action')
            if action == 'retype':
                shape(item, ('sig', 'action', 'type', 'new_sig', 'forms'))
                entity(item['new_sig'], item['type'], item['forms'])
                require(item['new_sig'] != sig, 'retype must change sig')
            elif action == 'remove_forms':
                shape(item, ('sig', 'action', 'forms'))
                forms = strings(item['forms'], minimum=1)
                require(forms <= set(hubs[sig]['forms']), 'removing unreported forms')
                require(sig.split(':', 1)[-1].replace('-', ' ') not in forms, 'cannot remove base form')
            else:
                shape(item, ('sig', 'action'))
        deferred = {r['key'].removeprefix('hubs:') for r in (audit or {}).get('reviews', [])
                    if r.get('outcome') == 'defer' and r.get('key', '').startswith('hubs:')}
        require(seen | deferred == set(hubs) and not seen & deferred,
                'each hub needs an engine action or explicit audited deferral without mutation')
        targets = {d['sig'] for d in payload['decisions']} | {
            r['new_sig'] for r in payload['hub_reviews'] if r['action'] == 'retype'}
        require(not targets & deferred, 'deferred hubs cannot be decision or retype targets')
        # Entity decisions have no source-fact IDs. Structural work may reweave
        # any matching fact, so an individual fact deferral cannot be isolated.
        if any(k.startswith('facts:') for k in deferred_keys):
            require(not payload['decisions'] and all(r['action'] == 'keep' for r in payload['hub_reviews']),
                    'deferred entity facts require no structural entity work; source mapping is unavailable')
    elif surface == 'salience':
        facts = {f['sig'] for f in report['facts']}
        valid = facts | {f['sig'] for f in report['review']}
        seen = set()
        for item in payload['salient']:
            shape(item, ('sig', 'score'))
            require(isinstance(item['sig'], str) and item['sig'] in facts and item['sig'] not in seen, 'unknown/duplicate salience sig')
            seen.add(item['sig'])
            require(type(item['score']) in (float, int) and 0 <= item['score'] <= 1, 'score must be numeric in [0,1]')
        down = strings(payload['downgrade'])
        require(down <= valid and not down & seen, 'unknown/conflicting downgrade')
        deferred = {r['key'].split(':', 1)[1] for r in (audit or {}).get('reviews', [])
                    if r.get('outcome') == 'defer' and r.get('key', '').startswith(('facts:', 'review:'))}
        require(not deferred & (seen | down), 'deferred salience items must not be mutated')
        # Strong scores can spotlight unscored neighbors. Do not mirror the
        # engine's dynamic thresholds or neighbor selection in this adapter.
        require(not deferred_keys or not payload['salient'],
                'salience deferrals forbid all scoring because spotlight can mutate deferred neighbors; '
                'postpone scoring or resolve genuine evidence ambiguity; never change an audit just to bypass this gate')
    elif surface == 'merges':
        clusters = [{m['sig'] for m in c} for c in report['clusters']]
        claimed = set()
        for item in payload['decisions']:
            if item is None:
                continue
            shape(item, ('fact', 'survivorSig', 'memberSigs'))
            text(item['fact'], 8)
            members = strings(item['memberSigs'], minimum=2)
            require(item['survivorSig'] in members and any(members <= c for c in clusters) and not members & claimed,
                    'invalid/overlapping/cross-cluster merge')
            claimed.update(members)
        deferred_members = {sig for i, cluster in enumerate(clusters) if f'clusters:{i}' in deferred_keys for sig in cluster}
        require(not claimed & deferred_members, 'deferred merge clusters must not be mutated')
    elif surface == 'synthesis':
        claimed = set()
        for lane, source in (('decisions', 'pools'), ('reactivation_reviews', 'reactivation_pools')):
            pools = {p['poolId']: p for p in report[source]}
            seen = set()
            for item in payload[lane]:
                shape(item, ('poolId', 'groups') if lane == 'decisions' else ('poolId', 'action'),
                      () if lane == 'decisions' else ('groups',))
                pid = item['poolId']
                require(isinstance(pid, str) and pid in pools and pid not in seen, 'unknown/duplicate synthesis pool')
                require(f'{source}:{pid}' not in deferred_keys, 'deferred synthesis pools require no engine action')
                seen.add(pid)
                if lane == 'reactivation_reviews':
                    require(item['action'] in ('reject', 'synthesize'), 'invalid reactivation action')
                    if item['action'] == 'reject':
                        shape(item, ('poolId', 'action'))
                        continue
                groups = item.get('groups')
                require(isinstance(groups, list) and groups, 'synthesis requires nonempty groups')
                allowed = {m['sig'] for m in pools[pid]['members'] if source == 'pools' or m.get('archiveEligible') is True}
                for group in groups:
                    shape(group, ('concept', 'memberSigs', 'span', 'scale'))
                    text(group['concept'], 12)
                    text(group['span'])
                    text(group['scale'])
                    members = strings(group['memberSigs'], minimum=2)
                    require(members <= allowed and not members & claimed, 'invalid/overlapping synthesis members or protected recent exemplar')
                    claimed.update(members)
        deferred_members = {m['sig'] for source in ('pools', 'reactivation_pools')
                            for p in report[source] if f"{source}:{p['poolId']}" in deferred_keys
                            for m in p.get('members', [])}
        require(not claimed & deferred_members, 'deferred synthesis members must not be mutated through another pool')
    elif surface == 'chronicles':
        periods = {c['periodId']: c for c in report['candidates']}
        seen = set()
        for item in payload['decisions']:
            shape(item, ('periodId', 'summary', 'entries'))
            pid = item['periodId']
            require(isinstance(pid, str) and pid in periods and pid not in seen, 'unknown/duplicate chronicle period')
            require(f'candidates:{pid}' not in deferred_keys, 'deferred chronicle periods must not be mutated')
            seen.add(pid)
            text(item['summary'], 8)
            require(isinstance(item['entries'], list) and item['entries'], 'chronicle requires entries')
            members = {m['sig'] for m in periods[pid]['members']}
            entities = {e for m in periods[pid]['members'] for e in m.get('entitySigs', [])}
            covered = set()
            for entry in item['entries']:
                shape(entry, ('slot', 'summary', 'changeKind', 'evidenceSigs'), ('stateLabel', 'aspect', 'entitySigs'))
                text(entry['slot'])
                text(entry['summary'], 4)
                require(entry['changeKind'] in ('continuity', 'introduced', 'changed', 'resolved', 'reversed', 'completed'), 'invalid chronicle changeKind')
                evidence = strings(entry['evidenceSigs'], minimum=1)
                require(evidence <= members and strings(entry.get('entitySigs', [])) <= entities, 'invented chronicle evidence/entity')
                for field in ('stateLabel', 'aspect'):
                    if field in entry:
                        text(entry[field])
                covered.update(evidence)
            require(covered == members, 'incomplete chronicle evidence coverage')


def validate_result(surface, payload, result):
    require(isinstance(result, dict) and result.get('surface') == surface, 'apply returned wrong/missing surface')
    require(result.get('complete') is not False and not result.get('rejected'), 'incomplete/rejected apply')
    if surface not in ('aliases', 'salience'):
        require(result.get('complete') is True, 'apply lacks complete=true')
    expected = {}
    if surface == 'entities':
        expected = {'accepted': len(payload['decisions']), 'hub_reviews_applied': len(payload['hub_reviews'])}
    elif surface == 'aliases':
        expected = {'groups': len(payload), 'aliases_merged': sum(len(g['aliases']) for g in payload)}
    elif surface == 'merges':
        expected = {'clusters_merged': sum(d is not None for d in payload['decisions'])}
    elif surface == 'synthesis':
        expected = {'concepts_created': sum(len(d.get('groups', [])) for lane in ('decisions', 'reactivation_reviews') for d in payload[lane]),
                    'reactivation_reviewed': len(payload['reactivation_reviews'])}
    elif surface == 'chronicles':
        expected = {'chronicles_created': len(payload['decisions'])}
    elif surface == 'salience':
        expected = {'scored': sum(d['score'] < 0.5 for d in payload['salient'])}
        for field, upper in (('salient_tagged', sum(d['score'] >= 0.5 for d in payload['salient'])),
                             ('downgraded', len(payload['downgrade']))):
            require(type(result.get(field)) is int and 0 <= result[field] <= upper, 'invalid salience apply count')
    for field, count in expected.items():
        require(type(result.get(field)) is int and result[field] == count, f'apply did not accept expected {field}={count}; reconcile fresh report')


def validate_audit(report, payload, audit):
    shape(audit, ('author', 'report_digest', 'payload_digest', 'reviews'))
    require(audit['author'] == 'caller-llm', 'audit must attest caller-llm authorship')
    require(audit['report_digest'] == digest(report), 'audit report digest mismatch')
    require(audit['payload_digest'] == digest(payload), 'audit payload digest mismatch')
    require(isinstance(audit['reviews'], list), 'reviews must be an array')
    keys = []
    for review in audit['reviews']:
        shape(review, ('key', 'outcome', 'rationale'))
        require(isinstance(review['key'], str), 'review key must be a string')
        require(review['outcome'] in ('apply', 'decline', 'keep', 'defer'), 'invalid review outcome')
        reason = review['rationale']
        require(isinstance(reason, str) and len(reason.strip()) >= 40 and len(reason.split()) >= 7,
                'each item requires a substantive evidence-based rationale (>=40 chars, >=7 words)')
        keys.append(review['key'])
    require(len(keys) == len(set(keys)) and set(keys) == set(review_keys(report)),
            'audit coverage mismatch: every report item needs exactly one review')
    if any(r['outcome'] == 'defer' for r in audit['reviews']):
        validate_payload(report, payload, audit)


class Harness:
    def __init__(self, home=None, engine=None, daily_dir=None):
        require_supported_platform()
        self.home = Path(home or os.environ.get('HERMES_HOME') or
                         os.environ.get('DREAM_HARNESS_HOME') or Path.home() / '.hermes').expanduser().resolve()
        config_path = self.home / 'dreamweave-adapter.json'
        config = load(config_path) if config_path.exists() else {'version': 1}
        shape(config, ('version',), ('engine', 'daily_dir', 'entry_target', 'memory_char_limit'))
        require(config['version'] == 1, 'unsupported adapter configuration version')
        engine = engine or os.environ.get('DREAM_HARNESS_ENGINE') or config.get('engine')
        daily_dir = daily_dir or os.environ.get('HARNESS_DAILY_MEMORY_DIR') or config.get('daily_dir')
        require(engine and daily_dir, 'configure engine and daily_dir explicitly with install.py or environment')
        self.engine = Path(engine).expanduser().resolve()
        self.snapshot = Path(__file__).resolve().with_name('adapter-snapshot.js')
        self.data = self.home / 'dreamweave-data'
        self.db = self.data / 'memory.db'
        self.memory = self.home / 'memories/MEMORY.md'
        self.cycles = self.data / 'cycles'
        for path in (self.db, self.cycles, self.memory, self.memory.parent / 'USER.md',
                     Path(str(self.memory) + '.projection.json')):
            require(path.resolve().is_relative_to(self.home), f'storage path escapes selected profile: {path}')
        target = int(os.environ.get('DREAM_HARNESS_ENTRY_TARGET', config.get('entry_target', 200)))
        char_limit = int(os.environ.get('HARNESS_MEMORY_CHAR_LIMIT', config.get('memory_char_limit', 2200)))
        require(target > 0 and char_limit > 0, 'entry target and memory character limit must be positive')
        self.env = os.environ.copy()
        self.env.update(HERMES_HOME=str(self.home), AGENT_MEMORY_DIR=str(self.data), DREAM_MEMORY_DIR=str(self.data),
                        MEMORY_DB=str(self.db), MEMORY_MODEL_CACHE=os.environ.get('MEMORY_MODEL_CACHE', str(self.data / 'model-cache')),
                        HARNESS_MEMORY_DIR=str(self.memory.parent), HARNESS_MEMORY_FILE=str(self.memory),
                        HARNESS_DAILY_MEMORY_DIR=str(Path(daily_dir).expanduser().resolve()),
                        HARNESS_MEMORY_FORMAT='hermes', MEMORY_ENTRY_TARGET=str(target), MEMORY_ENTRY_MAX=str(target),
                        HARNESS_MEMORY_CHAR_LIMIT=str(char_limit),
                        MEMORY_VIZ=str(self.data / 'memory-graph.html'))
        self.env['HARNESS_DAILY_MEMORY_DIRS'] = json.dumps([self.env['HARNESS_DAILY_MEMORY_DIR']])
        self.env['HARNESS_PROJECTION_MANIFEST'] = str(self.memory) + '.projection.json'
        self.state = None
        self.cycle = None

    @contextmanager
    def lock(self):
        self.cycles.mkdir(parents=True, exist_ok=True)
        with (self.cycles / '.lock').open('a') as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as e:
                raise Refused('another harness operation holds the lock') from e
            yield

    def source_digests(self):
        return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
                for p in (self.memory, self.memory.parent / 'USER.md')}

    def unchanged_sources(self):
        require(self.source_digests() == self.state['source_digests'], 'MEMORY/USER source files changed since begin snapshot; preserve edits and stop')

    def checkpoint(self):
        save(self.cycle / 'state.json', self.state)

    def run(self, action, **kwargs):
        with self.lock():
            pointer = self.cycles / 'current.json'
            if pointer.exists():
                self.cycle = self.cycles / load(pointer)['cycle']
                require(self.cycle.resolve().parent == self.cycles.resolve(), 'invalid cycle path')
                self.state = load(self.cycle / 'state.json')
                if not self.state['complete'] or action != 'begin':
                    require(self.state['engine'] == str(self.engine), 'cycle engine root changed')
                    self.env = {k: v for k, v in self.env.items() if not k.startswith(('MEMORY_', 'HARNESS_')) and k not in ('AGENT_MEMORY_DIR', 'DREAM_MEMORY_DIR')}
                    self.env.update(self.state['environment'])
            require(action == 'begin' or self.state is not None, 'run begin first')
            if action != 'status' and self.state:
                require(not self.state.get('inflight'), 'uncertain interrupted operation; inspect state and logs before manual recovery')
            return getattr(self, '_' + action)(**kwargs)

    def command(self, name, args=(), *, script='src/dream.js', parse=True, mutates=False, env=None):
        token = name + '-' + uuid.uuid4().hex[:12]
        out = self.cycle / (token + '.stdout')
        err = self.cycle / (token + '.stderr')
        argv = ['node', str(self.engine / script), *map(str, args)]
        if mutates:
            self.state['inflight'] = {'name': name, 'argv': argv, 'stdout': str(out), 'stderr': str(err)}
            self.checkpoint()
        # Stream subprocess output to disk, not a bounded exec buffer or nightly dump.
        with out.open('w') as stdout, err.open('w') as stderr:
            result = subprocess.run(argv, env=env or self.env, stdout=stdout, stderr=stderr, text=True)
        if mutates and result.returncode != 0:
            self.state.pop('inflight', None)
            self.checkpoint()
        require(result.returncode == 0, f'{name} exit {result.returncode}; see {out} and {err}; re-report before retry')
        value = load(out) if parse else {'output': str(out)}
        if isinstance(value, dict):
            if mutates and (value.get('complete') is False or value.get('rejected')):
                self.state.pop('inflight', None)
                self.checkpoint()
            require(value.get('complete') is not False and not value.get('rejected'), f'{name} incomplete/rejected; see {out}')
        save(self.cycle / (token + '.receipt.json'), {'argv': argv, 'exit_code': result.returncode, 'output': str(out)})
        return value

    def engine_call(self, command, *args):
        return self.command(command, [command, *args, '--as-of', self.state['as_of']],
                            mutates=not command.startswith('report-') and command not in ('doctor', 'verify-sync', 'export-harness'))

    def health(self):
        result = self.engine_call('doctor')
        require(result.get('healthy') is True and result.get('fact_islands') == 0 and
                result.get('dangling_edges') == 0, 'doctor unhealthy; projection forbidden')
        return result

    def _status(self):
        return {'cycle': str(self.cycle), 'as_of': self.state['as_of'],
                'state_path': str(self.cycle / 'state.json'), 'complete': self.state['complete'],
                'next_surface': next((s for s in SURFACES if s not in self.state['done']), None),
                'current_report': self.state.get('report'), 'pending': self.state.get('pending', {}),
                'inflight': self.state.get('inflight')}

    def current_surface(self, surface=None):
        require('doctor' in self.state['setup'], 'begin setup incomplete; resume begin')
        current = next((s for s in SURFACES if s not in self.state['done']), None)
        require(current is not None and not self.state['complete'], 'all surfaces done; use finish')
        require(surface is None or current == surface, f'out of order: expected {current}')
        return current

    def report_args(self, surface):
        return ['--max-candidates', '1'] if surface == 'chronicles' else []

    def store_report(self, surface, value):
        require(value.get('surface') == surface, 'wrong report surface')
        keys = review_keys(value)
        folder = self.cycle / ('report-' + surface + '-' + uuid.uuid4().hex[:12])
        folder.mkdir(mode=0o700)
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
        atomic_text(folder / 'report.json', text + '\n')
        # read_file clips long individual lines independently of its page budget.
        # JSON arrays of short string fragments remain lossless and tool-readable.
        chunks = []
        for i, start in enumerate(range(0, len(text), 24000)):
            path = folder / f'full-{i:04d}.json'
            chunk = text[start:start + 24000]
            save(path, [chunk[j:j + 600] for j in range(0, len(chunk), 600)])
            chunks.append(str(path))
        save(folder / 'review-keys.json', keys)
        meta = {'surface': surface, 'report_path': str(folder / 'report.json'), 'digest': digest(value),
                'report_id': value.get('report_id'), 'item_count': len(keys),
                'review_index': str(folder / 'review-keys.json'), 'chunks': chunks,
                'schema_path': str(self.engine / 'docs/JUDGMENT-SURFACES.md'), 'schema_lines': '1-end',
                'as_of': self.state['as_of'], 'manifest_path': str(folder / 'manifest.json')}
        save(folder / 'manifest.json', meta)
        return meta

    def _report(self, surface=None):
        surface = self.current_surface(surface)
        paths = self.state['applies'].get(surface, [])
        if paths and surface not in ('chronicles', 'synthesis'):
            self.state['done'][surface] = paths[-1]
            self.state.pop('report', None)
            self.checkpoint()
            return {'stage_reconciled': True, **self._status()}
        value = self.engine_call('report-' + surface, *self.report_args(surface))
        self.state['report'] = self.store_report(surface, value)
        if paths:
            self.settle_loop(surface, value, self.state['report'])
        self.checkpoint()
        if surface in self.state['done']:
            return {'stage_reconciled': True, **self._status()}
        return self.state['report']

    def _apply(self, payload, audit, surface=None):
        surface = self.current_surface(surface)
        meta = self.state.get('report')
        require(meta and meta['surface'] == surface, 'run report and judge it first')
        report = load(meta['report_path'])
        require(digest(report) == meta['digest'], 'saved report was changed')
        decision, review = load(payload), load(audit)
        validate_payload(report, decision, review)
        validate_audit(report, decision, review)
        fresh = self.engine_call('report-' + surface, *self.report_args(surface))
        fresh_meta = self.store_report(surface, fresh)
        require(digest(fresh) == meta['digest'], f'stale report; re-report and reconcile all judgments; fresh report: {fresh_meta["report_path"]}')
        folder = self.cycle / ('apply-' + surface + '-' + uuid.uuid4().hex[:12])
        folder.mkdir(mode=0o700)
        save(folder / 'payload.json', decision)
        save(folder / 'audit.json', review)
        # Invalidate BEFORE mutation: a rejected/partial apply must be reconciled
        # against a new report; it can never become a completed stage receipt.
        self.state.pop('report', None)
        self.checkpoint()
        result = self.engine_call('apply-' + surface, '--file', folder / 'payload.json', *self.report_args(surface))
        try:
            validate_result(surface, decision, result)
        except Refused:
            self.state.pop('inflight', None)
            self.checkpoint()
            raise
        receipt = {'surface': surface, 'accepted': True, 'report_digest': meta['digest'],
                   'report_path': meta['report_path'], 'fresh_report_path': fresh_meta['report_path'],
                   'payload_path': str(folder / 'payload.json'), 'audit_path': str(folder / 'audit.json'),
                   'payload_digest': digest(decision), 'audit_digest': digest(review), 'result': result}
        path = folder / 'receipt.json'
        save(path, receipt)
        self.state['applies'].setdefault(surface, []).append(str(path))
        deferred = [r['key'] for r in review['reviews'] if r['outcome'] == 'defer']
        if deferred and surface not in ('synthesis', 'chronicles'):
            self.state.setdefault('pending', {})[surface] = {
                'deferred_items': deferred, 'count': len(deferred), 'audit_path': str(folder / 'audit.json')}
        self.state.pop('inflight', None)
        self.checkpoint()
        if surface in ('chronicles', 'synthesis'):
            remaining = self.engine_call('report-' + surface, *self.report_args(surface))
            remaining_meta = self.store_report(surface, remaining)
            self.settle_loop(surface, remaining, remaining_meta)
        else:
            self.state['done'][surface] = str(path)
        self.checkpoint()
        return {'receipt': str(path), **self._status()}

    def settle_loop(self, surface, remaining, remaining_meta):
        receipts = [load(p) for p in self.state['applies'][surface]]
        if surface == 'chronicles':
            count = sum(r['result']['chronicles_created'] for r in receipts)
            require(count <= 3, 'chronicle quota exceeded')
            has_more = bool(remaining['candidates'])
            pending = {'periods_applied': count, 'has_more': has_more,
                       'observed_pending_minimum': len(remaining['candidates']),
                       'exact_total': not has_more, 'report_path': remaining_meta['report_path']}
            done = count >= 3 or not has_more
        else:
            has_more = bool(remaining['pools'] or remaining['reactivation_pools'])
            pending = {'turns': len(receipts), 'has_more': has_more, 'report_path': remaining_meta['report_path']}
            done = len(receipts) >= 3 or receipts[-1]['result']['concepts_created'] == 0 or not has_more
        self.state.setdefault('pending', {})[surface] = pending
        if done:
            self.state['done'][surface] = self.state['applies'][surface][-1]
            self.state.pop('report', None)
        else:
            self.state['report'] = remaining_meta

    def _finish(self):
        require(set(self.state['done']) == set(SURFACES), 'all six surfaces need accepted receipts before finish')
        for surface in SURFACES:
            paths = self.state['applies'].get(surface, [])
            require(paths and self.state['done'][surface] == paths[-1], f'missing {surface} stage receipt')
            for path in paths:
                receipt = load(path)
                require(receipt['accepted'] is True and receipt['surface'] == surface, 'invalid apply receipt')
                payload, audit = load(receipt['payload_path']), load(receipt['audit_path'])
                report = load(receipt['report_path'])
                require(digest(payload) == receipt['payload_digest'] and digest(audit) == receipt['audit_digest'] and
                        digest(report) == receipt['report_digest'] and
                        digest(load(receipt['fresh_report_path'])) == receipt['report_digest'], 'receipt artifact changed')
                validate_payload(report, payload, audit)
                validate_audit(report, payload, audit)
                validate_result(surface, payload, receipt['result'])
        if not self.state['complete']:
            self.unchanged_sources()
        # Verify this cycle's frozen ingestion scope. New daily observations are
        # recorded as deferred below, never ingested implicitly or overwritten.
        snapshot = self.cycle / 'snapshot.json'
        sync = self.engine_call('verify-sync', '--file', snapshot)
        require(sync.get('complete') is True, 'finish sync incomplete')
        if self.state['complete']:
            projection = self.state['projection']
            require(hashlib.sha256(self.memory.read_bytes()).hexdigest() == projection['sha256'], 'completed projection changed')
            require(digest(load(str(self.memory) + '.projection.json')) == projection['manifest_digest'], 'completed manifest changed')
            self.health()
            return {**self._status(), 'projection': projection}
        save(self.cycle / 'finish-weave.json', self.engine_call('weave'))
        self.state.pop('inflight', None)
        self.checkpoint()
        doctor = self.health()
        records = self.engine_call('export-harness')
        entry_max = int(self.env['MEMORY_ENTRY_MAX'])
        require(isinstance(records, list) and 0 < len(records) <= entry_max,
                f'export must contain 1..{entry_max} records; no silent truncation')
        require(len({r['signature'] for r in records}) == len(records), 'duplicate export signatures')
        rank = {'gist': 0, 'chronicle': 1}
        records.sort(key=lambda r: r.get('first_seen') or '', reverse=True)
        records.sort(key=lambda r: rank.get(r.get('tier'), 2))
        displays = [r.get('display') or r['fact'] for r in records]
        require(all(isinstance(t, str) and t.strip() and not re.search(r'^[ \t]*§[ \t]*\r?$', t, re.M) for t in displays), 'invalid projection cards')
        rendered = '\n§\n'.join(displays) + '\n'
        char_limit = int(self.env['HARNESS_MEMORY_CHAR_LIMIT'])
        require(len(rendered) <= char_limit,
                f'projection character budget exceeded: {len(rendered)} > {char_limit}; '
                'reconcile capacity explicitly; no truncation or automatic Hermes setting changes')
        content_hash = hashlib.sha256(rendered.encode()).hexdigest()
        export_path = self.cycle / 'projection-export.json'
        save(export_path, records)
        manifest = {'version': 1, 'memory_file': str(self.memory), 'as_of': self.state['as_of'],
                    'sha256': content_hash, 'records': records, 'displays': displays}
        save(self.cycle / 'projection-manifest.json', manifest)
        atomic_text(self.cycle / 'MEMORY.after.md', rendered)
        self.unchanged_sources()
        self.state['inflight'] = {'name': 'publish-projection', 'manifest': str(self.cycle / 'projection-manifest.json')}
        self.checkpoint()
        # Match adapter-snapshot's v1 manifest contract: exported cards are not
        # fresh observations. Neither re-ingest nor ordinal ID reassignment occurs.
        save(str(self.memory) + '.projection.json', manifest)
        atomic_text(self.memory, rendered)
        require(self.memory.read_text(encoding='utf-8') == rendered, 'projection readback mismatch')
        require(load(str(self.memory) + '.projection.json') == manifest, 'manifest readback mismatch')
        cards = [c.strip() for c in re.split(r'^[ \t]*§[ \t]*\r?$', self.memory.read_text(), flags=re.M) if c.strip()]
        require(cards == [d.strip() for d in displays] and len(cards) == len(manifest['records']), 'projection/manifest cardinality mismatch')
        self.state.pop('inflight', None)
        self.checkpoint()
        after = self.cycle / 'projection-snapshot.json'
        self.command('projection-snapshot', [after], script=self.snapshot, parse=False)
        require(not any(i.get('source') == 'memory-main' for i in load(after)), 'adapter re-imported projected cards; incompatible manifest')
        initial_ids = {i['id'] for i in load(snapshot)}
        after_items = load(after)
        deferred = [i for i in after_items if i['id'] not in initial_ids]
        require(all(i.get('source', '').startswith('daily:') for i in deferred), 'non-daily source changed during projection; cycle incomplete')
        save(self.cycle / 'deferred-daily.json', deferred)
        synced = self.cycle / 'projection-sync-snapshot.json'
        save(synced, [i for i in after_items if i['id'] in initial_ids])
        sync_after = self.engine_call('verify-sync', '--file', synced)
        require(sync_after.get('complete') is True, 'post-projection sync incomplete')
        doctor_after = self.health()
        projection = {'path': str(self.memory), 'count': len(cards), 'sha256': content_hash,
                      'manifest_digest': digest(manifest), 'export_path': str(export_path), 'sync': sync_after,
                      'deferred_daily_items': len(deferred), 'deferred_daily_path': str(self.cycle / 'deferred-daily.json')}
        save(self.cycle / 'finish-receipt.json', {'projection': projection, 'doctor_before': doctor,
                                                'doctor_after': doctor_after, 'sync_before': sync})
        self.state['projection'] = projection
        self.state['complete'] = True
        self.checkpoint()
        return {**self._status(), 'projection': projection}

    def _begin(self):
        if self.state is None or self.state['complete']:
            require(self.db.is_file(), f'missing existing database: {self.db}')
            require(self.memory.is_file(), f'missing projection: {self.memory}')
            now = datetime.now(timezone.utc)
            self.cycle = self.cycles / (now.strftime('%Y%m%dT%H%M%S.%fZ') + '-' + uuid.uuid4().hex[:8])
            self.cycle.mkdir(mode=0o700)
            self.state = {'version': 1, 'as_of': now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                          'setup': {}, 'done': {}, 'applies': {}, 'complete': False, 'engine': str(self.engine),
                          'source_digests': self.source_digests(),
                          'environment': {k: v for k, v in self.env.items() if k.startswith(('MEMORY_', 'HARNESS_')) or k in ('AGENT_MEMORY_DIR', 'DREAM_MEMORY_DIR')}}
            self.checkpoint()
            save(self.cycles / 'current.json', {'cycle': self.cycle.name})
        setup = self.state['setup']
        self.unchanged_sources()
        if 'backup' not in setup:
            with sqlite3.connect(self.db.as_uri() + '?mode=ro', uri=True) as source:
                with sqlite3.connect(self.cycle / 'backup.db') as target:
                    source.backup(target)
            shutil.copy2(self.memory, self.cycle / 'MEMORY.before.md')
            manifest = Path(str(self.memory) + '.projection.json')
            if manifest.exists():
                shutil.copy2(manifest, self.cycle / 'MEMORY.before.projection.json')
            setup['backup'] = True
            self.checkpoint()
        snapshot = self.cycle / 'snapshot.json'
        steps = (
            ('snapshot', lambda: self.command('snapshot', [snapshot], script=self.snapshot, parse=False)),
            ('ingest', lambda: self.engine_call('ingest-harness', '--file', snapshot)),
            ('verify', lambda: self.engine_call('verify-sync', '--file', snapshot)),
            ('dream', lambda: self.engine_call('dream')),
            ('weave', lambda: self.engine_call('weave')),
            ('doctor', self.health),
        )
        for key, fn in steps:
            if key not in setup:
                result = fn()
                if key == 'snapshot':
                    self.unchanged_sources()
                if key in ('ingest', 'verify'):
                    require(result.get('complete') is True, f'{key} lacks complete=true')
                path = self.cycle / ('setup-' + key + '.json')
                save(path, result)
                setup[key] = str(path)
                self.state.pop('inflight', None)
                self.checkpoint()
        return self._status()


def small_output(value):
    if isinstance(value, dict):
        return {k: small_output(v) for k, v in value.items() if k != 'chunks'}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['begin', 'status', 'report', 'apply', 'finish'])
    parser.add_argument('--surface', choices=SURFACES)
    parser.add_argument('--payload', type=Path)
    parser.add_argument('--audit', type=Path)
    args = parser.parse_args()
    kwargs = {}
    if args.action == 'apply':
        if args.payload is None or args.audit is None:
            parser.error('apply requires --payload and --audit; neither is generated automatically')
        kwargs.update(payload=args.payload, audit=args.audit)
    elif args.payload is not None or args.audit is not None:
        parser.error('--payload/--audit are only valid with apply')
    if args.surface:
        if args.action not in ('report', 'apply'):
            parser.error('--surface is only valid with report/apply')
        kwargs['surface'] = args.surface
    try:
        print(json.dumps(small_output(Harness().run(args.action, **kwargs)), separators=(',', ':')))
    except (Refused, OSError, ValueError, KeyError, TypeError) as e:
        print(json.dumps({'complete': False, 'error': str(e)}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
