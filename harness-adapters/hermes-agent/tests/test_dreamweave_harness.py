"""Isolated tests: never open the installed live Dreamweave database."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/dreamweave_harness.py'
ENGINE = Path(os.environ.get('DREAM_TEST_ENGINE', Path(__file__).resolve().parents[3])).resolve()


class DeferralTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('harness', MODULE)
        assert spec is not None and spec.loader is not None
        self.h = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.h)

    def audit(self, report, payload, deferred):
        return {'author': 'caller-llm', 'report_digest': self.h.digest(report),
                'payload_digest': self.h.digest(payload),
                'reviews': [{'key': key, 'outcome': 'defer' if key in deferred else 'apply',
                             'rationale': 'The available evidence is insufficient to change salience so leave this item unchanged.'}
                            for key in self.h.review_keys(report)]}

    def test_other_surfaces_cannot_mutate_deferred_items(self):
        hub = {'sig': 'org:uncertain', 'type': 'org', 'forms': ['uncertain', 'alternate']}
        other = {'sig': 'org:other', 'type': 'org', 'forms': ['other']}
        entities = {'surface': 'entities', 'report_id': 'r', 'facts': [], 'hubs': [hub, other]}
        keep_other = {'sig': other['sig'], 'action': 'keep'}
        group = {'concept': 'A synthetic recurring database theme.', 'memberSigs': ['a', 'b'],
                 'span': 'two dated observations', 'scale': 'two episodes'}
        members = [{'sig': s, 'archiveEligible': True} for s in ('a', 'b')]
        cases = []
        for action in ('keep', 'reject', 'retype', 'remove_forms'):
            review = {'sig': hub['sig'], 'action': action}
            if action == 'retype':
                review.update(type='team', new_sig='team:uncertain', forms=['uncertain'])
            if action == 'remove_forms':
                review['forms'] = ['alternate']
            cases.append((entities, {'report_id': 'r', 'decisions': [], 'hub_reviews': [review, keep_other]},
                          'hubs:' + hub['sig']))
        cases.extend([
            (entities, {'report_id': 'r', 'decisions': [hub], 'hub_reviews': [keep_other]}, 'hubs:' + hub['sig']),
            (entities, {'report_id': 'r', 'decisions': [], 'hub_reviews': [
                {'sig': other['sig'], 'action': 'retype', 'type': 'org', 'new_sig': hub['sig'], 'forms': ['other']}]},
             'hubs:' + hub['sig']),
            ({'surface': 'entities', 'report_id': 'r', 'facts': [{'sig': 'f'}], 'hubs': []},
             {'report_id': 'r', 'decisions': [hub], 'hub_reviews': []}, 'facts:f'),
        ])
        for deferred in (hub['sig'], other['sig']):
            cases.append(({'surface': 'aliases', 'hubs': [hub, other]},
                          [{'canonical': hub['sig'], 'aliases': [other['sig']]}], 'hubs:' + deferred))
        cases.append(({'surface': 'merges', 'report_id': 'r', 'clusters': [members]},
                      {'report_id': 'r', 'decisions': [None, {'fact': 'A synthetic merged observation.',
                       'survivorSig': 'a', 'memberSigs': ['a', 'b']}]}, 'clusters:0'))
        for lane, source, action in [('decisions', 'pools', None),
                                     ('reactivation_reviews', 'reactivation_pools', 'synthesize'),
                                     ('reactivation_reviews', 'reactivation_pools', 'reject')]:
            report = {'surface': 'synthesis', 'report_id': 'r', 'pools': [], 'reactivation_pools': []}
            report[source] = [{'poolId': 'p', 'members': members}]
            payload = {'report_id': 'r', 'decisions': [], 'reactivation_reviews': []}
            decision = {'poolId': 'p', 'groups': [group]}
            if action:
                decision['action'] = action
            if action == 'reject':
                decision.pop('groups')
            payload[lane] = [decision]
            cases.append((report, payload, source + ':p'))
        cases.append(({'surface': 'chronicles', 'report_id': 'r', 'candidates': [{'periodId': 'day:x', 'members': members}]},
                      {'report_id': 'r', 'decisions': [{'periodId': 'day:x', 'summary': 'A synthetic dated summary.',
                       'entries': [{'slot': 'morning', 'summary': 'Synthetic events occurred.', 'changeKind': 'completed',
                                    'evidenceSigs': ['a', 'b']}]}]}, 'candidates:day:x'))
        for report, payload, deferred in cases:
            audit = self.audit(report, payload, {deferred})
            with self.subTest(surface=report['surface'], payload=payload, deferred=deferred):
                with self.assertRaisesRegex(self.h.Refused, 'defer'):
                    self.h.validate_payload(report, payload, audit)
                with self.assertRaisesRegex(self.h.Refused, 'defer'):
                    self.h.validate_audit(report, payload, audit)

    def test_deferred_pool_members_cannot_be_mutated_through_another_pool(self):
        members = [{'sig': s, 'archiveEligible': True} for s in ('a', 'b')]
        report = {'surface': 'synthesis', 'report_id': 'r',
                  'pools': [{'poolId': 'active', 'members': members}],
                  'reactivation_pools': [{'poolId': 'cold', 'members': members}]}
        payload = {'report_id': 'r', 'decisions': [{'poolId': 'active', 'groups': [
            {'concept': 'A synthetic recurring pattern.', 'memberSigs': ['a', 'b'],
             'span': 'two days', 'scale': 'two episodes'}]}], 'reactivation_reviews': []}
        audit = self.audit(report, payload, {'reactivation_pools:cold'})
        with self.assertRaisesRegex(self.h.Refused, 'defer'):
            self.h.validate_audit(report, payload, audit)

    def test_nonmutating_deferrals_and_existing_sparse_outcomes_remain_valid(self):
        cases = [
            ({'surface': 'entities', 'report_id': 'r', 'facts': [{'sig': 'f'}], 'hubs': [{'sig': 'org:uncertain'}]},
             {'report_id': 'r', 'decisions': [], 'hub_reviews': []}),
            ({'surface': 'aliases', 'hubs': [{'sig': 'org:uncertain'}]}, []),
            ({'surface': 'salience', 'facts': [{'sig': 'f'}], 'review': [{'sig': 'r'}]},
             {'salient': [], 'downgrade': []}),
            ({'surface': 'merges', 'report_id': 'r', 'clusters': [[{'sig': 'a'}, {'sig': 'b'}]]},
             {'report_id': 'r', 'decisions': [None]}),
            ({'surface': 'synthesis', 'report_id': 'r', 'pools': [{'poolId': 'p'}], 'reactivation_pools': [{'poolId': 'r'}]},
             {'report_id': 'r', 'decisions': [], 'reactivation_reviews': []}),
            ({'surface': 'chronicles', 'report_id': 'r', 'candidates': [{'periodId': 'day:x'}]},
             {'report_id': 'r', 'decisions': []}),
        ]
        for report, payload in cases:
            with self.subTest(surface=report['surface']):
                audit = self.audit(report, payload, set(self.h.review_keys(report)))
                self.h.validate_payload(report, payload, audit)
                self.h.validate_audit(report, payload, audit)
        report = {'surface': 'salience', 'facts': [{'sig': 'f'}, {'sig': 'other'}], 'review': []}
        for outcome in ('apply', 'keep', 'decline'):
            payload = {'salient': [{'sig': 'other', 'score': 0.3}], 'downgrade': []}
            audit = self.audit(report, payload, set())
            audit['reviews'][0]['outcome'] = outcome
            self.h.validate_payload(report, payload, audit)
            self.h.validate_audit(report, payload, audit)

    def test_salience_deferral_forbids_all_scores_even_for_other_facts(self):
        for lane in ('facts', 'review'):
            report = {'surface': 'salience', 'facts': [{'sig': 'other'}], 'review': []}
            report[lane].append({'sig': 'f'})
            for score in (0, 0.3, 1):
                payload = {'salient': [{'sig': 'other', 'score': score}], 'downgrade': []}
                audit = self.audit(report, payload, {lane + ':f'})
                with self.subTest(lane=lane, score=score):
                    with self.assertRaisesRegex(self.h.Refused, 'defer.*spotlight'):
                        self.h.validate_payload(report, payload, audit)
                    with self.assertRaisesRegex(self.h.Refused, 'defer.*spotlight'):
                        self.h.validate_audit(report, payload, audit)

    def test_salience_deferral_rejects_score_and_downgrade_before_engine(self):
        from unittest.mock import patch
        for lane, mutation in [('facts', {'salient': [{'sig': 'f', 'score': 1}], 'downgrade': []}),
                               ('facts', {'salient': [{'sig': 'f', 'score': 0}], 'downgrade': []}),
                               ('facts', {'salient': [], 'downgrade': ['f']}),
                               ('review', {'salient': [], 'downgrade': ['f']})]:
            report = {'surface': 'salience', 'facts': [], 'review': []}
            report[lane] = [{'sig': 'f'}]
            audit = self.audit(report, mutation, {lane + ':f'})
            with self.subTest(lane=lane, mutation=mutation):
                with self.assertRaisesRegex(self.h.Refused, 'defer'):
                    self.h.validate_payload(report, mutation, audit)
                with self.assertRaisesRegex(self.h.Refused, 'defer'):
                    self.h.validate_audit(report, mutation, audit)
                with tempfile.TemporaryDirectory(prefix='dream-defer-test-') as root:
                    home = Path(root)
                    runner = self.h.Harness(home, ENGINE, daily_dir=home / 'daily')
                    runner.cycle = home
                    runner.state = {'setup': {'doctor': True}, 'complete': False, 'as_of': '2026-09-10T00:00:00Z',
                                    'done': dict.fromkeys(('entities', 'aliases')), 'applies': {}}
                    runner.state['report'] = runner.store_report('salience', report)
                    self.h.save(home / 'payload.json', mutation)
                    self.h.save(home / 'audit.json', audit)
                    with patch.object(runner, 'engine_call') as engine:
                        with self.assertRaisesRegex(self.h.Refused, 'defer'):
                            runner._apply(home / 'payload.json', home / 'audit.json')
                        engine.assert_not_called()
                    self.assertEqual(runner.state['applies'], {})
                    self.assertNotIn('salience', runner.state['done'])


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='dream-harness-test-')
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        spec = importlib.util.spec_from_file_location('harness', MODULE)
        self.assertTrue(MODULE.exists(), 'checkpointed harness implementation is missing')
        self.h = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.h)
        self.runner = self.h.Harness(self.home, ENGINE, daily_dir=self.home / 'daily')
        if os.environ.get('DREAM_TEST_MODEL_CACHE'):
            self.runner.env['MEMORY_MODEL_CACHE'] = os.environ['DREAM_TEST_MODEL_CACHE']
        self.runner.memory.parent.mkdir(parents=True)
        Path(self.runner.env['HARNESS_DAILY_MEMORY_DIR']).mkdir(parents=True)
        self.runner.memory.write_text('')
        subprocess.run(['node', str(ENGINE / 'src/dream.js'), 'init'],
                       env=self.runner.env, check=True, capture_output=True)

    def test_begin_backups_and_resumes_frozen_cycle(self):
        manifest = {'version': 1, 'memory_file': str(self.runner.memory), 'records': [], 'displays': []}
        self.h.save(str(self.runner.memory) + '.projection.json', manifest)
        with sqlite3.connect(self.runner.db) as db:
            db.execute('pragma journal_mode=WAL')
            db.execute('create table backup_probe(value text)')
            db.execute("insert into backup_probe values ('committed WAL row')")
        first = self.runner.run('begin')
        second = self.h.Harness(self.home, ENGINE, daily_dir=self.home / 'daily').run('begin')
        self.assertEqual(first['cycle'], second['cycle'])
        self.assertEqual(first['as_of'], second['as_of'])
        self.assertEqual(second['next_surface'], 'entities')
        cycle = Path(first['cycle'])
        with sqlite3.connect(cycle / 'backup.db') as db:
            self.assertEqual(db.execute('pragma integrity_check').fetchone()[0], 'ok')
        self.assertEqual((cycle / 'MEMORY.before.md').read_text(), '')
        self.assertEqual(self.h.load(cycle / 'MEMORY.before.projection.json'), manifest)
        with sqlite3.connect(cycle / 'backup.db') as db:
            self.assertEqual(db.execute('select value from backup_probe').fetchone()[0], 'committed WAL row')
        state = json.loads((cycle / 'state.json').read_text())
        self.assertEqual(set(state['setup']), {'backup', 'snapshot', 'ingest', 'verify', 'dream', 'weave', 'doctor'})
        self.assertEqual(self.runner.env['MEMORY_ENTRY_TARGET'], '200')
        self.assertEqual(self.runner.env['MEMORY_ENTRY_MAX'], '200')

    def test_report_persists_full_content_and_audit_keys(self):
        self.runner.run('begin')
        result = self.runner.run('report')
        report = json.loads(Path(result['report_path']).read_text())
        self.assertEqual(report['surface'], 'entities')
        self.assertEqual(result['digest'], self.h.digest(report))
        self.assertEqual(result['item_count'], 0)
        self.assertTrue(Path(result['schema_path']).is_file())
        self.assertTrue(Path(result['review_index']).is_file())
        with self.assertRaises(self.h.Refused):
            self.runner.run('report', surface='salience')
        huge = {'surface': 'entities', 'report_id': 'r', 'facts': [{'sig': 'f', 'fact': 'full text ' * 18000}], 'hubs': []}
        result = self.runner.store_report('entities', huge)
        self.assertEqual(json.loads(Path(result['report_path']).read_text()), huge)
        # read_file clips single lines at 2000 chars even when truncated=false.
        for p in result['chunks']:
            self.assertLessEqual(max(map(len, Path(p).read_text().splitlines())), 1800)
        chunks = [json.loads(Path(p).read_text()) for p in result['chunks']]
        self.assertTrue(all(isinstance(chunk, list) for chunk in chunks))
        self.assertEqual(''.join(part for chunk in chunks for part in chunk), json.dumps(huge, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
        self.assertEqual(self.h.review_keys(huge), ['facts:f'])
    def test_explicit_deferred_hubs_remain_unmodified_and_visible(self):
        report = {'surface':'entities','report_id':'r','facts':[],
                  'hubs':[{'sig':'org:uncertain','type':'org','forms':['uncertain']}]}
        payload = {'report_id':'r','decisions':[],'hub_reviews':[]}
        audit = {'author':'caller-llm','report_digest':self.h.digest(report),
                 'payload_digest':self.h.digest(payload),
                 'reviews':[{'key':'hubs:org:uncertain','outcome':'defer',
                             'rationale':'The supplied samples concern other subjects and cannot support an identity change.'}]}
        self.h.validate_payload(report, payload, audit)
        self.h.validate_audit(report, payload, audit)
        with self.assertRaises(self.h.Refused):
            self.h.validate_payload(report, payload)
        audit['reviews'][0]['outcome'] = 'keep'
        with self.assertRaises(self.h.Refused):
            self.h.validate_payload(report, payload, audit)

    def decision_files(self, report, payload, reviews=None):
        p, a = self.home / 'payload.json', self.home / 'audit.json'
        self.h.save(p, payload)
        self.h.save(a, {'author': 'caller-llm', 'report_digest': report['digest'],
                        'payload_digest': self.h.digest(payload), 'reviews': reviews or []})
        return {'payload': p, 'audit': a}

    def spotlight_fixture(self):
        self.runner.run('begin')
        # Real engine/schema/vector search, synthetic data only; no model download.
        seed = r"""
const Database = require('better-sqlite3');
const vec = require('sqlite-vec');
const cfg = require('./config');
const db = new Database(process.env.MEMORY_DB);
vec.load(db);
const embedding = new Float32Array(cfg.EMBED_DIM);
embedding[0] = 1;
for (const [sig, fact] of [
  ['fixture:apply', 'Synthetic incident requires an urgent database correction.'],
  ['fixture:defer', 'Synthetic related database observation awaiting judgment.']
]) {
  const info = db.prepare("INSERT INTO nodes(signature,kind,class,strength,first_seen,fact,dirty_seq) VALUES (?,'fact','episodic',0.2,'2026-09-10T12:00:00.000Z',?,1)").run(sig, fact);
  db.prepare('INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)').run(BigInt(info.lastInsertRowid), Buffer.from(embedding.buffer));
}
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','1')").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_reflect_seq','0')").run();
db.close();
"""
        subprocess.run(['node', '-e', seed], cwd=ENGINE, env=self.runner.env,
                       check=True, capture_output=True)
        for surface in ('entities', 'aliases'):
            meta = self.runner.run('report', surface=surface)
            payload = {'report_id': meta['report_id'], 'decisions': [], 'hub_reviews': []} if surface == 'entities' else []
            reviews = [{'key': key, 'outcome': 'decline',
                        'rationale': 'Synthetic observations do not establish a named entity or any aliases to change.'}
                       for key in self.h.review_keys(self.h.load(meta['report_path']))]
            self.runner.run('apply', **self.decision_files(meta, payload, reviews))
        return self.runner.run('report', surface='salience')

    def test_salience_deferral_blocks_indirect_engine_spotlight(self):
        meta = self.spotlight_fixture()
        report = self.h.load(meta['report_path'])
        self.assertEqual(set(self.h.review_keys(report)), {'facts:fixture:apply', 'facts:fixture:defer'})
        payload = {'salient': [{'sig': 'fixture:apply', 'score': 1}], 'downgrade': []}
        reviews = [{'key': key, 'outcome': 'defer' if key == 'facts:fixture:defer' else 'apply',
                    'rationale': 'This synthetic evidence leaves the related observation ambiguous and only supports scoring the incident.'}
                   for key in self.h.review_keys(report)]
        files = self.decision_files(meta, payload, reviews)
        originals = {k: p.read_bytes() for k, p in files.items()}
        with sqlite3.connect(self.runner.db) as db:
            before = db.execute("SELECT * FROM nodes WHERE signature='fixture:defer'").fetchone()
        refusal = None
        try:
            self.runner.run('apply', **files)
        except self.h.Refused as exc:
            refusal = str(exc)
        with sqlite3.connect(self.runner.db) as db:
            after = db.execute("SELECT * FROM nodes WHERE signature='fixture:defer'").fetchone()
            strength = db.execute("SELECT strength FROM nodes WHERE signature='fixture:defer'").fetchone()[0]
            edges = db.execute("SELECT src,rel,dst FROM edges WHERE rel='spotlight'").fetchall()
        receipts = [self.h.load(p)['accepted'] for p in self.runner.cycle.glob('apply-salience-*/receipt.json')]
        self.assertEqual({'refused': refusal is not None, 'strength': strength, 'edges': edges, 'receipts': receipts},
                         {'refused': True, 'strength': 0.2, 'edges': [], 'receipts': []})
        assert refusal is not None
        self.assertRegex(refusal, 'defer.*spotlight')
        self.assertEqual(after, before, 'deferred neighbor must remain entirely unchanged')
        self.assertEqual({k: p.read_bytes() for k, p in files.items()}, originals)
        self.assertFalse(list(self.runner.cycle.glob('apply-salience-*')))
        status = self.runner.run('status')
        self.assertEqual(status['next_surface'], 'salience')
        self.assertNotIn('salience', self.runner.state['applies'])
        self.assertNotIn('salience', self.runner.state['done'])
        self.assertIsNone(status['inflight'])

    def test_salience_without_deferral_exercises_real_spotlight(self):
        meta = self.spotlight_fixture()
        report = self.h.load(meta['report_path'])
        payload = {'salient': [{'sig': 'fixture:apply', 'score': 1}], 'downgrade': []}
        reviews = [{'key': key, 'outcome': 'apply' if key == 'facts:fixture:apply' else 'keep',
                    'rationale': 'The synthetic incident merits scoring and the related observation has no unresolved evidence ambiguity.'}
                   for key in self.h.review_keys(report)]
        result = self.runner.run('apply', **self.decision_files(meta, payload, reviews))
        receipt = self.h.load(result['receipt'])
        self.assertTrue(receipt['accepted'])
        self.assertEqual(receipt['result']['spotlighted'], 1)
        with sqlite3.connect(self.runner.db) as db:
            self.assertAlmostEqual(db.execute("SELECT strength FROM nodes WHERE signature='fixture:defer'").fetchone()[0], 0.32)
            self.assertEqual(db.execute("SELECT src,rel,dst FROM edges WHERE rel='spotlight'").fetchall(),
                             [('fixture:apply', 'spotlight', 'fixture:defer')])

    def test_salience_nondeferred_downgrade_leaves_deferred_neighbor_unchanged(self):
        self.spotlight_fixture()
        with sqlite3.connect(self.runner.db) as db:
            db.execute("UPDATE nodes SET salience_score=1, salience='decision' WHERE signature='fixture:apply'")
            before = db.execute("SELECT * FROM nodes WHERE signature='fixture:defer'").fetchone()
        meta = self.runner.run('report', surface='salience')
        report = self.h.load(meta['report_path'])
        self.assertIn('facts:fixture:defer', self.h.review_keys(report))
        payload = {'salient': [], 'downgrade': ['fixture:apply']}
        reviews = [{'key': key, 'outcome': 'defer' if key == 'facts:fixture:defer' else 'apply',
                    'rationale': 'Synthetic evidence revokes incident importance while leaving the related observation ambiguous and unchanged.'}
                   for key in self.h.review_keys(report)]
        result = self.runner.run('apply', **self.decision_files(meta, payload, reviews))
        receipt = self.h.load(result['receipt'])
        self.assertTrue(receipt['accepted'])
        self.assertEqual(receipt['result']['downgraded'], 1)
        self.assertEqual(receipt['result']['spotlighted'], 0)
        self.assertEqual(result['pending']['salience']['deferred_items'], ['facts:fixture:defer'])
        with sqlite3.connect(self.runner.db) as db:
            self.assertEqual(db.execute("SELECT * FROM nodes WHERE signature='fixture:defer'").fetchone(), before)
            self.assertEqual(db.execute("SELECT salience_score FROM nodes WHERE signature='fixture:apply'").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT src,rel,dst FROM edges WHERE rel='spotlight'").fetchall(), [])

    def test_empty_surfaces_require_explicit_bound_audit_and_receipts(self):
        self.runner.run('begin')
        for surface in self.h.SURFACES:
            report = self.runner.run('report', surface=surface)
            rid = report['report_id']
            payload = {'entities': {'report_id': rid, 'decisions': [], 'hub_reviews': []},
                       'aliases': [], 'salience': {'salient': [], 'downgrade': []},
                       'merges': {'report_id': rid, 'decisions': []},
                       'synthesis': {'report_id': rid, 'decisions': [], 'reactivation_reviews': []},
                       'chronicles': {'report_id': rid, 'decisions': []}}[surface]
            files = self.decision_files(report, payload)
            audit = self.h.load(files['audit'])
            self.h.save(files['audit'], {**audit, 'author': 'script'})
            with self.assertRaises(self.h.Refused):
                self.runner.run('apply', **files)
            self.h.save(files['audit'], audit)
            result = self.runner.run('apply', **files)
            receipt = self.h.load(result['receipt'])
            self.assertEqual(receipt['surface'], surface)
            self.assertTrue(receipt['accepted'])
            self.assertTrue(Path(receipt['payload_path']).exists())
            self.assertTrue(Path(receipt['audit_path']).exists())
        self.assertIsNone(self.runner.run('status')['next_surface'])
        self.assertFalse(self.runner.run('status')['complete'])
    def test_nested_schemas_reject_engine_silent_sanitization(self):
        cases = [
            ({'surface': 'entities', 'report_id': 'r', 'facts': [], 'hubs': []},
             {'report_id': 'r', 'decisions': [{'sig': 'person:x', 'type': 'hub', 'forms': []}], 'hub_reviews': []}),
            ({'surface': 'aliases', 'hubs': [{'sig': 'person:alice'}]},
             [{'canonical': 'person:alice', 'aliases': ['person:invented']}]),
            ({'surface': 'salience', 'facts': [{'sig': 'f'}], 'review': []},
             {'salient': [{'sig': 'f', 'score': '1'}], 'downgrade': []}),
            ({'surface': 'merges', 'report_id': 'r', 'clusters': [[{'sig': 'a'}, {'sig': 'b'}], [{'sig': 'c'}, {'sig': 'd'}]]},
             {'report_id': 'r', 'decisions': [{'fact': 'A real consolidated fact.', 'survivorSig': 'a', 'memberSigs': ['a', 'c']}]}),
            ({'surface': 'synthesis', 'report_id': 'r', 'pools': [], 'reactivation_pools': [{'poolId': 'p', 'members': [{'sig': 'a', 'archiveEligible': True}, {'sig': 'b', 'archiveEligible': False}]}]},
             {'report_id': 'r', 'decisions': [], 'reactivation_reviews': [{'poolId': 'p', 'action': 'synthesize', 'groups': [{'concept': 'A real semantic concept.', 'memberSigs': ['a', 'b'], 'span': 'dated evidence', 'scale': 'two episodes'}]}]}),
            ({'surface': 'chronicles', 'report_id': 'r', 'candidates': [{'periodId': 'day:x', 'members': [{'sig': 'a'}, {'sig': 'b'}]}]},
             {'report_id': 'r', 'decisions': [{'periodId': 'day:x', 'summary': 'Named facts occurred on a dated day.', 'entries': [{'slot': 'morning', 'summary': 'Fact a occurred.', 'changeKind': 'introduced', 'evidenceSigs': ['a']}]}]}),
        ]
        for report, payload in cases:
            with self.subTest(surface=report['surface']), self.assertRaises(self.h.Refused):
                self.h.validate_payload(report, payload)
    def test_chronicles_three_period_quota_admits_backlog(self):
        import shutil
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        self.runner.state['done'].pop('chronicles')
        self.runner.state['applies'].pop('chronicles')
        self.runner.checkpoint()
        with sqlite3.connect(self.runner.db) as db:
            for i in range(1, 5):
                day = f'2020-01-0{i}'
                db.execute("INSERT INTO nodes(signature,memory_id,kind,class,strength,notes,fact,first_seen,source_day,dirty_seq) VALUES (?,?, 'fact','episodic',0.1,'archive',?,?,?,?)",
                           (f'fixture-{i}', f'fixture-id-{i}', f'On {day}, Iris completed database test case {i}.', day, day, i))
        for i in range(3):
            meta = self.runner.run('report', surface='chronicles')
            report = self.h.load(meta['report_path'])
            self.assertEqual(len(report['candidates']), 1)
            c = report['candidates'][0]
            payload = {'report_id': report['report_id'], 'decisions': [{'periodId': c['periodId'],
                'summary': f"During {c['periodStart']} through {c['periodEnd']}, Iris completed the database test described in the evidence.",
                'entries': [{'slot': c['periodStart'], 'summary': m['fact'], 'changeKind': 'completed', 'evidenceSigs': [m['sig']]} for m in c['members']]}]}
            reviews = [{'key': 'candidates:' + c['periodId'], 'outcome': 'apply',
                        'rationale': 'The dated evidence explicitly names Iris completing database tests; the timeline preserves every supplied member.'}]
            result = self.runner.run('apply', **self.decision_files(meta, payload, reviews))
            if i < 2:
                self.assertEqual(result['next_surface'], 'chronicles')
        self.assertIsNone(result['next_surface'])
        self.assertTrue(result['pending']['chronicles']['has_more'])
        self.assertFalse(result['pending']['chronicles']['exact_total'])
        self.assertEqual(result['pending']['chronicles']['periods_applied'], 3)
        with sqlite3.connect(self.runner.db) as db:
            self.assertEqual(db.execute('select count(*) from chronicles').fetchone()[0], 3)
        for path in self.runner.cycle.glob('*.receipt.json'):
            command = self.h.load(path)['argv']
            if any(x in command for x in ('report-chronicles', 'apply-chronicles')):
                self.assertEqual(command[command.index('--max-candidates') + 1], '1')
                self.assertNotIn('--resummarize', command)
        # Simulate loss after durable accepted receipt, before stage bookkeeping.
        self.runner.state['done'].pop('chronicles')
        self.runner.checkpoint()
        reconciled = self.runner.run('report')
        self.assertTrue(reconciled.get('stage_reconciled'))
        self.assertIsNone(reconciled['next_surface'])
        self.assertEqual(self.runner.state['pending']['chronicles']['periods_applied'], 3)
    def test_apply_boundary_failures_never_mark_stage_done(self):
        from unittest.mock import patch
        self.runner.run('begin')
        for code, response in [(3, {'surface': 'entities', 'complete': True}),
                               (0, {'surface': 'entities', 'complete': False}),
                               (0, {'surface': 'entities', 'complete': True, 'rejected': ['partial']}),
                               (0, {'surface': 'entities', 'complete': True})]:
            meta = self.runner.run('report')
            files = self.decision_files(meta, {'report_id': meta['report_id'], 'decisions': [], 'hub_reviews': []})
            real_run = subprocess.run
            def boundary(argv, **kwargs):
                if 'apply-entities' not in argv:
                    return real_run(argv, **kwargs)
                kwargs['stdout'].write(json.dumps(response))
                return subprocess.CompletedProcess(argv, code)
            with self.subTest(code=code, response=response), patch.object(self.h.subprocess, 'run', boundary):
                with self.assertRaises(self.h.Refused):
                    self.runner.run('apply', **files)
                self.assertEqual(self.runner.run('status')['next_surface'], 'entities')
                self.assertNotIn('entities', self.runner.state['applies'])
    def test_finish_requires_receipts_health_sync_and_exact_projection(self):
        self.runner.run('begin')
        with self.assertRaises(self.h.Refused):
            self.runner.run('finish')
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        receipt_path = Path(self.runner.state['done']['entities'])
        saved = receipt_path.read_text()
        receipt_path.unlink()
        with self.assertRaises((self.h.Refused, OSError)):
            self.runner.run('finish')
        self.assertEqual(self.runner.memory.read_text(), '')
        receipt_path.write_text(saved)
        result = self.runner.run('finish')
        self.assertTrue(result['complete'])
        self.assertEqual(result['projection']['count'], 1)
        self.assertEqual(result['projection']['path'], str(self.runner.memory))
        self.assertTrue(result['projection']['sync']['complete'])
        expected = self.h.load(Path(result['projection']['export_path']))
        self.assertEqual(self.runner.memory.read_text(), '\n§\n'.join(r.get('display') or r['fact'] for r in expected) + '\n')
        manifest = self.h.load(str(self.runner.memory) + '.projection.json')
        self.assertEqual(manifest['records'], expected)
        self.assertEqual(self.runner.run('finish')['projection'], result['projection'])
    def test_cli_report_apply_and_small_stdout(self):
        env = dict(self.runner.env, HERMES_HOME=str(self.home), DREAM_HARNESS_ENGINE=str(ENGINE), HARNESS_DAILY_MEMORY_DIR=str(self.home / 'daily'))
        def cli(*args):
            return subprocess.run(['python3', str(MODULE), *map(str, args)], env=env, capture_output=True, text=True)
        begin = cli('begin')
        self.assertEqual(begin.returncode, 0, begin.stderr)
        report = cli('report', '--surface', 'entities')
        self.assertEqual(report.returncode, 0, report.stderr)
        meta = json.loads(report.stdout)
        self.assertNotIn('chunks', meta)
        self.assertTrue(Path(meta['manifest_path']).is_file())
        files = self.decision_files(meta, {'report_id': meta['report_id'], 'decisions': [], 'hub_reviews': []})
        applied = cli('apply', '--payload', files['payload'], '--audit', files['audit'])
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(json.loads(applied.stdout)['next_surface'], 'aliases')
        self.assertLess(len(applied.stdout), 6000)
        self.assertNotEqual(cli('finish').returncode, 0)
        self.assertNotEqual(cli('apply').returncode, 0)
    def test_crash_after_engine_success_preserves_uncertain_checkpoint(self):
        from unittest.mock import patch
        self.runner.run('begin')
        meta = self.runner.run('report')
        files = self.decision_files(meta, {'report_id': meta['report_id'], 'decisions': [], 'hub_reviews': []})
        real_save = self.h.save
        def crash(path, value):
            if str(path).endswith('/receipt.json'):
                raise KeyboardInterrupt('simulated process loss after engine commit')
            return real_save(path, value)
        with patch.object(self.h, 'save', crash), self.assertRaises(KeyboardInterrupt):
            self.runner.run('apply', **files)
        status = self.runner.run('status')
        self.assertIsNotNone(status['inflight'])
        with self.assertRaises(self.h.Refused):
            self.runner.run('report')
    def test_same_report_id_changed_full_fact_is_stale(self):
        self.runner.run('begin')
        with sqlite3.connect(self.runner.db) as db:
            db.execute("INSERT INTO nodes(signature,kind,class,strength,fact,dirty_seq) VALUES ('fact:iris','fact','episodic',0.5,'Iris owns database tests.',1)")
        meta = self.runner.run('report')
        reviews = [{'key': key, 'outcome': 'decline', 'rationale': 'This isolated evidence does not yet establish a recurring named subject that needs a separate hub.'}
                   for key in self.h.review_keys(self.h.load(meta['report_path']))]
        files = self.decision_files(meta, {'report_id': meta['report_id'], 'decisions': [], 'hub_reviews': []}, reviews)
        with sqlite3.connect(self.runner.db) as db:
            db.execute("UPDATE nodes SET fact='Iris no longer owns database tests.' WHERE signature='fact:iris'")
        with self.assertRaisesRegex(self.h.Refused, 'stale report'):
            self.runner.run('apply', **files)
        fresh = self.runner.run('report')
        self.assertEqual(meta['report_id'], fresh['report_id'])
        self.assertNotEqual(meta['digest'], fresh['digest'])
        self.assertNotIn('entities', self.runner.state['applies'])

    def test_audit_coverage_all_lanes_rejects_empty_duplicates_and_short_reasons(self):
        reports = [
            {'surface': 'entities', 'facts': [{'sig': 'f'}], 'hubs': [{'sig': 'h'}]},
            {'surface': 'aliases', 'hubs': [{'sig': 'h'}]},
            {'surface': 'salience', 'facts': [{'sig': 'f'}], 'review': [{'sig': 'r'}]},
            {'surface': 'merges', 'clusters': [[{'sig': 'a'}, {'sig': 'b'}]]},
            {'surface': 'synthesis', 'pools': [{'poolId': 'p'}], 'reactivation_pools': [{'poolId': 'r'}]},
            {'surface': 'chronicles', 'candidates': [{'periodId': 'day:x'}]},
        ]
        for report in reports:
            keys = self.h.review_keys(report)
            audit = {'author': 'caller-llm', 'report_digest': self.h.digest(report), 'payload_digest': self.h.digest([]),
                     'reviews': [{'key': key, 'outcome': 'decline', 'rationale': f'{key} has insufficient specific evidence for the proposed structural change; retain the underlying observations.'} for key in keys]}
            self.h.validate_audit(report, [], audit)
            for reviews in ([], audit['reviews'] + audit['reviews'], [{**r, 'rationale': 'reviewed'} for r in audit['reviews']]):
                with self.subTest(surface=report['surface']), self.assertRaises(self.h.Refused):
                    self.h.validate_audit(report, [], {**audit, 'reviews': reviews})

    def test_lock_refuses_overlapping_helper_operation(self):
        self.runner.run('begin')
        with self.runner.lock(), self.assertRaisesRegex(self.h.Refused, 'lock'):
            self.h.Harness(self.home, ENGINE, daily_dir=self.home / 'daily').run('status')

    def test_finish_unhealthy_zero_exit_never_projects(self):
        from unittest.mock import patch
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        real_run = subprocess.run
        def unhealthy(argv, **kwargs):
            if 'doctor' not in argv:
                return real_run(argv, **kwargs)
            kwargs['stdout'].write(json.dumps({'healthy': True, 'fact_islands': 1, 'dangling_edges': 0}))
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(self.h.subprocess, 'run', unhealthy), self.assertRaises(self.h.Refused):
            self.runner.run('finish')
        self.assertEqual(self.runner.memory.read_text(), '')
        self.assertFalse(self.runner.run('status')['complete'])

    def test_finish_new_unsynced_observation_never_overwrites_it(self):
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        observation = 'A fresh observation arrived while the caller was judging.'
        self.runner.memory.write_text(observation)
        with self.assertRaises(self.h.Refused):
            self.runner.run('finish')
        self.assertEqual(self.runner.memory.read_text(), observation)
        self.assertFalse(self.runner.run('status')['complete'])

    def test_post_publication_failure_requires_operator_recovery_even_without_inflight(self):
        from unittest.mock import patch
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        real_command = self.runner.command
        def fail_snapshot(name, *args, **kwargs):
            if name == 'projection-snapshot':
                raise self.h.Refused('injected post-publication snapshot failure')
            return real_command(name, *args, **kwargs)
        with patch.object(self.runner, 'command', fail_snapshot):
            with self.assertRaisesRegex(self.h.Refused, 'injected post-publication'):
                self.runner.run('finish')
        published = self.runner.memory.read_text()
        self.assertNotEqual(published, '')
        self.assertTrue(Path(str(self.runner.memory) + '.projection.json').exists())
        resumed = self.h.Harness(self.home, ENGINE, daily_dir=self.home / 'daily')
        status = resumed.run('status')
        self.assertFalse(status['complete'])
        self.assertIsNone(status['inflight'])
        with self.assertRaisesRegex(self.h.Refused, 'source files changed'):
            resumed.run('finish')
        self.assertEqual(self.runner.memory.read_text(), published)

    def test_environment_paths_and_recovery_mode_are_frozen_per_cycle(self):
        self.runner.env['MEMORY_INCREMENTAL_WEAVE'] = '0'
        self.runner.run('begin')
        resumed = self.h.Harness(self.home, ENGINE, daily_dir=self.home / 'daily')
        resumed.env['MEMORY_INCREMENTAL_WEAVE'] = '1'
        resumed.run('status')
        self.assertEqual(resumed.env['MEMORY_INCREMENTAL_WEAVE'], '0')
        self.assertEqual(json.loads(resumed.env['HARNESS_DAILY_MEMORY_DIRS']), [resumed.env['HARNESS_DAILY_MEMORY_DIR']])
        self.assertEqual(resumed.env['HARNESS_PROJECTION_MANIFEST'], str(resumed.memory) + '.projection.json')
    def test_finish_preserves_even_nonsnapshot_memory_and_user_edits(self):
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        for path in (self.runner.memory, self.runner.memory.parent / 'USER.md'):
            with self.subTest(path=path):
                existed = path.exists()
                before = path.read_text() if existed else None
                path.write_text('\n')
                with self.assertRaisesRegex(self.h.Refused, 'source.*changed'):
                    self.runner.run('finish')
                self.assertEqual(path.read_text(), '\n')
                if existed:
                    path.write_text(before)
                else:
                    path.unlink()

    def test_finish_defers_new_daily_logs_without_overwriting_them(self):
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        daily = Path(self.runner.env['HARNESS_DAILY_MEMORY_DIR']) / '2026-09-10.md'
        content = 'A new daily observation arrived after the frozen ingestion snapshot.'
        daily.write_text(content)
        result = self.runner.run('finish')
        self.assertTrue(result['complete'])
        self.assertEqual(result['projection']['deferred_daily_items'], 1)
        self.assertEqual(daily.read_text(), content)
        self.assertTrue(result['projection']['sync']['complete'])
    def test_finish_enforces_configured_record_ceiling(self):
        from unittest.mock import patch
        self.runner.env['MEMORY_ENTRY_TARGET'] = self.runner.env['MEMORY_ENTRY_MAX'] = '1'
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        real_run = subprocess.run
        def oversized(argv, **kwargs):
            if 'export-harness' not in argv:
                return real_run(argv, **kwargs)
            kwargs['stdout'].write(json.dumps([
                {'signature': 'fixture-one', 'fact': 'First synthetic card.', 'tier': 'gist'},
                {'signature': 'fixture-two', 'fact': 'Second synthetic card.', 'tier': 'gist'}]))
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(self.h.subprocess, 'run', oversized), self.assertRaisesRegex(self.h.Refused, 'records'):
            self.runner.run('finish')
        self.assertEqual(self.runner.memory.read_text(), '')
        self.assertFalse(Path(str(self.runner.memory) + '.projection.json').exists())

    def test_finish_rejects_character_overflow_without_truncation(self):
        from unittest.mock import patch
        self.runner.env['HARNESS_MEMORY_CHAR_LIMIT'] = '20'
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        real_run = subprocess.run
        def oversized(argv, **kwargs):
            if 'export-harness' not in argv:
                return real_run(argv, **kwargs)
            kwargs['stdout'].write(json.dumps([{'signature': 'fixture', 'fact': '雪' * 20, 'tier': 'gist'}]))
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(self.h.subprocess, 'run', oversized), self.assertRaisesRegex(self.h.Refused, 'character'):
            self.runner.run('finish')
        self.assertEqual(self.runner.memory.read_text(), '')
        self.assertFalse(Path(str(self.runner.memory) + '.projection.json').exists())
        self.assertFalse(self.runner.run('status')['complete'])

    def test_finish_rejects_ambiguous_card_boundaries_before_publication(self):
        from unittest.mock import patch
        self.test_empty_surfaces_require_explicit_bound_audit_and_receipts()
        real_run = subprocess.run
        def ambiguous(argv, **kwargs):
            if 'export-harness' not in argv:
                return real_run(argv, **kwargs)
            kwargs['stdout'].write(json.dumps([{'signature': 'fixture', 'fact': 'First card\n  §  \nSecond card', 'tier': 'gist'}]))
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(self.h.subprocess, 'run', ambiguous), self.assertRaises(self.h.Refused):
            self.runner.run('finish')
        self.assertEqual(self.runner.memory.read_text(), '')


if __name__ == '__main__':
    unittest.main()
