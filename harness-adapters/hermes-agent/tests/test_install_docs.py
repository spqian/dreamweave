"""Installation contract checks; never configure a live profile."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
GUIDE = ROOT / 'harness-adapters/hermes-agent/install.md'


class InstallDocsTests(unittest.TestCase):
    def test_dependency_install_precedes_setup_and_wording_is_truthful(self):
        guide = GUIDE.read_text()
        commands = re.findall(r'^(npm (?:install|ci|run setup))$', guide, re.M)
        self.assertGreaterEqual(len(commands), 2, 'document npm install before npm run setup')
        self.assertIn(commands[0], ('npm install', 'npm ci'))
        self.assertEqual(commands[1], 'npm run setup')
        for path in (GUIDE, ROOT / 'INSTALL.md', ROOT / 'README.md'):
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertNotRegex(path.read_text(), r'(?is)setup`\)?[^.\n]*prepares dependencies')


    def test_four_knob_commands_persist_in_selected_profile_before_first_cycle(self):
        import json
        import shlex
        guide = GUIDE.read_text()
        commands = re.findall(r'^node src/dream\.js config (?:set \w+ \w+|show)$', guide, re.M)
        sets = [shlex.split(c) for c in commands if ' config set ' in c]
        self.assertEqual({c[-2] for c in sets}, {'retention', 'capacity', 'forgetting', 'connections'})
        self.assertEqual(len(sets), 4)
        self.assertEqual(commands[-1], 'node src/dream.js config show')
        self.assertLess(guide.index(commands[-1]), guide.index('## 4.'))
        exports = re.findall(r'^export (?:HERMES_HOME|DREAM_MEMORY_DIR|AGENT_MEMORY_DIR|MEMORY_CONFIG|MEMORY_DB)=.*$', guide, re.M)
        # The guide permits substituting agreed choices. Exercise that exact
        # command/export scaffold with explicitly nondefault values in a sandbox;
        # do not change the guide's recommended example defaults.
        expected = {'retention': 'prune', 'capacity': 'expansive',
                    'forgetting': 'fast', 'connections': 'thorough'}
        sandbox_commands = [shlex.join(c[:-1] + [expected[c[-2]]]) for c in sets] + [commands[-1]]
        with tempfile.TemporaryDirectory(prefix='dream-install-docs-') as root:
            env = {k: v for k, v in os.environ.items()
                   if not k.startswith(('MEMORY_', 'HARNESS_', 'DREAM_', 'AGENT_MEMORY'))}
            home = Path(root) / 'selected-profile'
            env.update(HOME=root, HERMES_HOME=str(home))
            response = {}
            for command in sandbox_commands:
                result = subprocess.run(['bash', '-c', '\n'.join(exports + [command])],
                                        cwd=ROOT, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                response = json.loads(result.stdout)
            self.assertEqual(response['knobs'], expected)
            self.assertEqual(response['configPath'], str(home / 'dreamweave-data/memory.config.json'))
            self.assertTrue(response['configExists'])
            self.assertEqual(json.loads(Path(response['configPath']).read_text())['knobs'], expected)
            self.assertFalse((Path(root) / '.dream-memory').exists())


if __name__ == '__main__':
    unittest.main()
