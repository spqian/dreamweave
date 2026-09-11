"""Portable configuration and installation: synthetic temporary roots only."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT.parents[1]


def module(name):
    path = ROOT / 'scripts' / (name + '.py')
    if not path.is_file():
        raise AssertionError(f'missing adapter implementation: {path.name}')
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


class PortabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='hermes-portable-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'profile'
        self.daily = self.root / 'journal'
        self.daily.mkdir()

    def install(self, *extra):
        return subprocess.run([sys.executable, str(ROOT / 'scripts/install.py'),
                               '--hermes-home', str(self.home), '--engine', str(ENGINE),
                               '--daily-dir', str(self.daily), *extra],
                              capture_output=True, text=True)

    def test_installer_stages_runnable_adapter_without_touching_user_data(self):
        self.home.mkdir()
        memory = self.home / 'memories/MEMORY.md'
        memory.parent.mkdir()
        memory.write_text('Existing private observation in a synthetic fixture.')
        (self.home / 'config.yaml').write_text('model: untouched-fixture-model\n')
        (self.home / 'cron').mkdir()
        (self.home / 'cron/jobs.json').write_text('["untouched-fixture-job"]')
        result = self.install('--entry-target', '29', '--memory-char-limit', '2400')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads((self.home / 'dreamweave-adapter.json').read_text())
        self.assertEqual(config, {'version': 1, 'engine': str(ENGINE),
                                 'daily_dir': str(self.daily), 'entry_target': 29,
                                 'memory_char_limit': 2400})
        for relative in ('scripts/dreamweave_harness.py', 'scripts/adapter-snapshot.js',
                         'scripts/dreamweave.py', 'skills/memory/dream/SKILL.md',
                         'skills/memory/dream/references/nightly-harness.md',
                         'skills/memory/graph-recall/SKILL.md'):
            self.assertTrue((self.home / relative).is_file(), relative)
        for script in ('dreamweave_harness.py', 'dreamweave.py'):
            check = subprocess.run([sys.executable, str(self.home / 'scripts' / script), '--help'],
                                   env={**os.environ, 'HERMES_HOME': str(self.home)},
                                   capture_output=True, text=True)
            self.assertEqual(check.returncode, 0, check.stderr)
        self.assertEqual(memory.read_text(), 'Existing private observation in a synthetic fixture.')
        self.assertEqual((self.home / 'config.yaml').read_text(), 'model: untouched-fixture-model\n')
        self.assertEqual((self.home / 'cron/jobs.json').read_text(), '["untouched-fixture-job"]')
        self.assertFalse((self.home / 'dreamweave-data').exists())

    def test_installer_upgrade_requires_consent_and_preserves_customized_backups(self):
        first = self.install()
        self.assertEqual(first.returncode, 0, first.stderr)
        again = self.install()
        self.assertEqual(again.returncode, 0, again.stderr)
        custom = self.home / 'skills/memory/dream/SKILL.md'
        custom.write_text('Customized synthetic skill. Preserve this version.')
        extra = custom.parent / 'operator-notes.md'
        extra.write_text('Operator-owned synthetic notes.')
        config = self.home / 'dreamweave-adapter.json'
        before = config.read_text()
        denied = self.install('--entry-target', '50')
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual(config.read_text(), before)
        self.assertEqual(custom.read_text(), 'Customized synthetic skill. Preserve this version.')
        upgraded = self.install('--upgrade', '--entry-target', '50')
        self.assertEqual(upgraded.returncode, 0, upgraded.stderr)
        backups = json.loads(upgraded.stdout)['backups']
        saved = {Path(p).read_text() for p in backups}
        self.assertIn(before, saved)
        self.assertIn('Customized synthetic skill. Preserve this version.', saved)
        self.assertEqual(extra.read_text(), 'Operator-owned synthetic notes.')
        self.assertEqual(json.loads(config.read_text())['entry_target'], 50)
        self.assertEqual(custom.read_text(), (ROOT / 'skills/dream/SKILL.md').read_text())

    def test_installer_refuses_symlink_destinations_outside_profile(self):
        self.home.mkdir()
        outside = self.root / 'outside'
        outside.mkdir()
        (self.home / 'scripts').symlink_to(outside, target_is_directory=True)
        result = self.install('--upgrade')
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse((self.home / 'dreamweave-adapter.json').exists())

    def test_windows_is_rejected_explicitly_before_installation(self):
        h = module('dreamweave_harness')
        with patch.object(h.sys, 'platform', 'win32'):
            with self.assertRaisesRegex(h.Refused, 'Windows|unsupported'):
                h.Harness(self.home, ENGINE, daily_dir=self.daily)
            with patch.object(sys, 'path', [str(ROOT / 'scripts'), *sys.path]):
                installer = module('install')
                with self.assertRaisesRegex(installer.Refused, 'Windows|unsupported'):
                    installer.install(self.home, ENGINE, self.daily)
        self.assertFalse(self.home.exists())

    def test_explicit_home_overrides_inherited_profile_in_child_environment(self):
        h = module('dreamweave_harness')
        with patch.dict(os.environ, {'HERMES_HOME': str(self.root / 'other-profile'),
                                     'MEMORY_DB': str(self.root / 'wrong.db'),
                                     'HARNESS_DAILY_MEMORY_DIRS': '["wrong-journal"]'}):
            runner = h.Harness(self.home, ENGINE, daily_dir=self.daily)
        self.assertEqual(runner.env['HERMES_HOME'], str(self.home))
        self.assertEqual(runner.env['MEMORY_DB'], str(self.home / 'dreamweave-data/memory.db'))
        self.assertEqual(json.loads(runner.env['HARNESS_DAILY_MEMORY_DIRS']), [str(self.daily)])

    def test_fresh_installed_profile_initializes_then_begins_a_real_cycle(self):
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        env = {**os.environ, 'HERMES_HOME': str(self.home)}
        for command in ([sys.executable, str(self.home / 'scripts/dreamweave.py'), 'init'],
                        [sys.executable, str(self.home / 'scripts/dreamweave_harness.py'), 'begin']):
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['next_surface'], 'entities')
        memory = self.home / 'memories/MEMORY.md'
        self.assertEqual(memory.read_text(), '')
        memory.write_text('Existing raw synthetic observation.')
        result = subprocess.run([sys.executable, str(self.home / 'scripts/dreamweave.py'), 'init'],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(memory.read_text(), 'Existing raw synthetic observation.')

    def test_profile_storage_cannot_resolve_into_another_profile(self):
        h = module('dreamweave_harness')
        self.home.mkdir()
        other = self.root / 'other-profile-data'
        other.mkdir()
        (self.home / 'dreamweave-data').symlink_to(other, target_is_directory=True)
        with self.assertRaisesRegex(h.Refused, 'profile'):
            h.Harness(self.home, ENGINE, daily_dir=self.daily)
        self.assertEqual(list(other.iterdir()), [])

    def test_explicit_config_uses_selected_profile_and_separate_engine(self):
        h = module('dreamweave_harness')
        self.home.mkdir()
        (self.home / 'dreamweave-adapter.json').write_text(json.dumps({
            'version': 1, 'engine': str(ENGINE), 'daily_dir': str(self.daily),
            'entry_target': 37, 'memory_char_limit': 3100}))
        with patch.dict(os.environ, {'HERMES_HOME': str(self.home)}, clear=True):
            runner = h.Harness()
        self.assertEqual(runner.home, self.home)
        self.assertEqual(runner.engine, ENGINE)
        self.assertEqual(runner.snapshot, ROOT / 'scripts/adapter-snapshot.js')
        self.assertEqual(runner.env['HARNESS_DAILY_MEMORY_DIR'], str(self.daily))
        self.assertEqual(runner.env['MEMORY_ENTRY_TARGET'], '37')
        self.assertEqual(runner.env['MEMORY_ENTRY_MAX'], '37')
        self.assertEqual(runner.env['HARNESS_MEMORY_CHAR_LIMIT'], '3100')
        self.assertEqual(runner.db, self.home / 'dreamweave-data/memory.db')


if __name__ == '__main__':
    unittest.main()
