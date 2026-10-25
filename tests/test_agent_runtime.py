"""Workers must retain the launch host/model instead of selecting an installed rival."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / '.claude/skills/crux-viewer/scripts'
sys.path.insert(0, str(SCRIPTS))


def test_codex_launcher_does_not_extract_with_claude(tmp_path, monkeypatch):
    from lib import extraction
    monkeypatch.setenv('CODEX_THREAD_ID', 'current-codex-thread')
    monkeypatch.setenv('CODEX_MODEL', 'gpt-6-astra')
    monkeypatch.setenv('CLAUDECODE', '1')
    monkeypatch.setattr(extraction.shutil, 'which', lambda name: name + '.exe')
    calls = []
    def invoke(command, **kwargs):
        calls.append(command)
        assert Path(command[0]).stem == 'codex'
        Path(command[command.index('-o') + 1]).write_text('{"claims": []}', encoding='utf-8')
        return SimpleNamespace(returncode=0, stdout='', stderr='')
    monkeypatch.setattr(extraction.subprocess, 'run', invoke)
    assert extraction.ask_model('Return source claims.', tmp_path) == {'claims': []}
    assert 'gpt-6-astra' in calls[0]


@pytest.mark.parametrize('host,model', [('codex', 'gpt-6-astra'), ('cursor', 'gpt-6-astra'), ('claude', 'claude-sonnet-5')])
def test_model_is_not_downgraded_or_cross_routed(host, model, tmp_path, monkeypatch):
    from lib.agent_runtime import AgentConfig, command_for
    monkeypatch.setattr('lib.agent_runtime.shutil.which', lambda name: name + '.exe')
    argv = command_for(AgentConfig(host, model, 'high'), tmp_path)
    assert model in argv
    assert not any(name in argv for name in ['--force', '--yolo', '--dangerously-bypass-approvals-and-sandbox'])
    if host == 'codex':
        assert argv[argv.index('--sandbox') + 1] == 'read-only'
        assert '--ephemeral' in argv
    elif host == 'cursor':
        assert argv[argv.index('--mode') + 1] == 'ask'
    else:
        assert argv[argv.index('--tools') + 1] == ''


def test_explicit_launch_beats_inherited_environment():
    from lib.agent_runtime import resolve_agent
    result = resolve_agent('cursor', 'gpt-5.6-sol', 'high', env={
        'CODEX_THREAD_ID': 'outer', 'CODEX_MODEL': 'gpt-6-astra', 'CLAUDECODE': '1'})
    assert (result.host, result.model, result.effort) == ('cursor', 'gpt-5.6-sol', 'high')


def test_missing_launch_model_is_an_error_not_a_claude_fallback(tmp_path):
    from lib.agent_runtime import resolve_agent
    result = resolve_agent('cursor', env={}, home=tmp_path)
    assert not result.model
    assert '--model' in result.problem()


def test_cursor_reply_label_survives_saved_chat(tmp_path):
    from lib.chat import append_message, load_chat
    message = append_message(tmp_path, '_workspace', role='assistant', text='Hello', agent='Cursor')
    assert message['agent'] == 'Cursor'
    assert load_chat(tmp_path, '_workspace')['messages'][0]['agent'] == 'Cursor'


def test_codex_worker_ignores_unrelated_mcp_configuration(tmp_path, monkeypatch):
    from lib.agent_runtime import AgentConfig, command_for
    monkeypatch.setattr('lib.agent_runtime.shutil.which', lambda name: name + '.exe')
    argv = command_for(AgentConfig('codex', 'gpt-6-astra'), tmp_path)
    assert '--ignore-user-config' in argv
    assert not any('mcp_servers.' in arg for arg in argv)


def test_cursor_object_model_configuration_retains_parameters(tmp_path):
    from lib.agent_runtime import resolve_agent
    folder = tmp_path / '.cursor'
    folder.mkdir()
    (folder / 'cli-config.json').write_text(json.dumps({'selectedModel': {
        'modelId': 'gpt-5.6-sol', 'parameters': [{'id': 'reasoning', 'value': 'high'}]}}))
    assert resolve_agent('cursor', env={}, home=tmp_path).model == 'gpt-5.6-sol[reasoning=high]'


def test_cursor_account_error_is_visible_without_changing_model(tmp_path, monkeypatch):
    from lib.agent_runtime import AgentConfig, ask_text
    monkeypatch.setattr('lib.agent_runtime.shutil.which', lambda name: name + '.exe')
    monkeypatch.setattr('lib.agent_runtime.subprocess.run', lambda *args, **kwargs: SimpleNamespace(
        returncode=1, stdout='', stderr='ActionRequiredError: Named models unavailable Free plans can only use Auto.'))
    with pytest.raises(RuntimeError, match='Named models unavailable'):
        ask_text(AgentConfig('cursor', 'gpt-5.6-sol-high'), 'question', tmp_path)


def test_relative_worker_directory_reads_the_cli_output(tmp_path, monkeypatch):
    from lib.agent_runtime import AgentConfig, ask_text
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr('lib.agent_runtime.shutil.which', lambda name: name + '.exe')
    def invoke(command, **kwargs):
        # A CLI resolves -o relative to its subprocess cwd, not the server cwd.
        output = Path(command[command.index('-o') + 1])
        if not output.is_absolute():
            output = Path(kwargs['cwd']) / output
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text('Controlled answer.', encoding='utf-8')
        return SimpleNamespace(returncode=0, stdout='', stderr='')
    monkeypatch.setattr('lib.agent_runtime.subprocess.run', invoke)
    assert ask_text(AgentConfig('codex', 'gpt-6-astra'), 'Question', Path('relative run/worker')) == 'Controlled answer.'
    assert (tmp_path / 'relative run/worker/reply.txt').read_text() == 'Controlled answer.'


def test_plain_terminal_launch_uses_the_installed_cli(tmp_path, monkeypatch):
    from lib.agent_runtime import resolve_agent
    monkeypatch.setattr('lib.agent_runtime.shutil.which', lambda name: 'codex.exe' if name == 'codex' else None)
    result = resolve_agent(env={}, home=tmp_path)
    assert result.host == 'codex'
    assert not result.problem()


@pytest.mark.parametrize('host', ['claude', 'codex'])
def test_unset_model_uses_the_cli_default_instead_of_refusing(host, tmp_path, monkeypatch):
    from lib.agent_runtime import AgentConfig, command_for
    monkeypatch.setattr('lib.agent_runtime.shutil.which', lambda name: name + '.exe')
    agent = AgentConfig(host)
    assert not agent.problem()
    assert '--model' not in command_for(agent, tmp_path)


def test_no_session_and_no_cli_explains_what_to_install(tmp_path, monkeypatch):
    from lib.agent_runtime import resolve_agent
    monkeypatch.setattr('lib.agent_runtime.shutil.which', lambda name: None)
    assert 'Install' in resolve_agent(env={}, home=tmp_path).problem()
