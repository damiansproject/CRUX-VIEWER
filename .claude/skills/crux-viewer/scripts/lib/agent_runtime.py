"""Run source-reading workers through the launching host's explicit model."""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib


@dataclass(frozen=True)
class AgentConfig:
    """Host/model identity captured when the Viewer starts, shared by its workers."""

    host: str
    model: str = ''
    effort: str = ''

    @property
    def label(self) -> str:
        """Return the user-visible host name."""
        return {'codex': 'Codex', 'cursor': 'Cursor', 'claude': 'Claude'}.get(self.host, 'Agent')

    def problem(self) -> str:
        """Explain missing launch context or CLI without selecting another provider."""
        if self.host not in {'codex', 'cursor', 'claude'}:
            return 'Install the Claude Code, Codex, or Cursor CLI and sign in, then restart Viewer.'
        if self.host == 'cursor' and (not self.model or self.model == 'auto'):
            return 'Pass --model with the model selected in your launching session.'
        if not _executable(self.host):
            return f'Install the {self.label} CLI and sign in, then restart Viewer.'
        return ''


def _read_settings(path: Path) -> dict:
    try:
        raw = path.read_text(encoding='utf-8-sig')
        value = tomllib.loads(raw) if path.suffix == '.toml' else json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def resolve_agent(host: str | None = None, model: str | None = None, effort: str | None = None,
                  *, env=None, home: Path | None = None) -> AgentConfig:
    """Prefer explicit launch arguments, then host identity and that host's model settings."""
    env = os.environ if env is None else env
    home = Path.home() if home is None else Path(home)
    host = host or env.get('CRUX_AGENT_HOST') or 'auto'
    if host == 'auto':
        # Nested shells may retain CLAUDECODE even though Codex owns this turn.
        host = ('codex' if env.get('CODEX_THREAD_ID') else
                'cursor' if env.get('CURSOR_TRACE_ID') or env.get('CURSOR_SESSION_ID') else
                'claude' if env.get('CLAUDECODE') else
                # A plain terminal has no session to follow: use the CLI that is installed.
                next((name for name in ('claude', 'codex', 'cursor') if _executable(name)), 'unknown'))
    host = 'claude' if host == 'claude-code' else host
    model = model or env.get('CRUX_AGENT_MODEL')
    effort = effort or env.get('CRUX_AGENT_EFFORT')
    if host == 'codex':
        settings = _read_settings(Path(env.get('CODEX_HOME') or home / '.codex') / 'config.toml')
        model = model or env.get('CODEX_MODEL') or settings.get('model')
        effort = effort or env.get('CODEX_REASONING_EFFORT') or settings.get('model_reasoning_effort')
    elif host == 'cursor':
        settings = _read_settings(home / '.cursor/cli-config.json')
        model = model or env.get('CURSOR_AGENT_MODEL') or env.get('CURSOR_MODEL') or settings.get('model')
        if not isinstance(model, str):
            selected = settings.get('selectedModel') or model or {}
            model = selected.get('modelId', '')
            parameters = selected.get('parameters', [])
            if model and parameters:
                model += '[' + ','.join(f'{row["id"]}={row["value"]}' for row in parameters) + ']'
    elif host == 'claude':
        settings = _read_settings(home / '.claude/settings.json')
        model = model or env.get('CLAUDE_MODEL') or env.get('ANTHROPIC_MODEL') or settings.get('model')
    return AgentConfig(host, model if isinstance(model, str) else '', effort if isinstance(effort, str) else '')


def _executable(host):
    return (shutil.which('agent') or shutil.which('cursor-agent')) if host == 'cursor' else shutil.which(host)


def _launcher(host):
    executable = _executable(host)
    if not executable:
        raise ValueError(f'{host} CLI was not found.')
    path = Path(executable)
    if os.name == 'nt' and path.suffix.lower() in {'.cmd', '.bat', '.ps1'}:
        script = path.with_suffix('.ps1')
        if not script.is_file():
            raise ValueError(f'Install the native {host} CLI or its PowerShell launcher.')
        return ['powershell.exe', '-NoProfile', '-File', str(script)]
    return [executable]


def _model_flag(agent):
    # No model given: the signed-in CLI uses its own default.
    return ['--model', agent.model] if agent.model and agent.model != 'auto' else []


def command_for(agent: AgentConfig, work_dir: Path, images: list[str] | None = None) -> list[str]:
    """Build a noninteractive read-only command; prompts travel over closed stdin."""
    if issue := agent.problem():
        raise ValueError(issue)
    command = _launcher(agent.host)
    if agent.host == 'codex':
        command += ['-a', 'never', 'exec', '--ignore-user-config', *_model_flag(agent), '--sandbox', 'read-only',
                    '--skip-git-repo-check', '--ephemeral', '--json', '-o', str(work_dir / 'reply.txt'),
                    '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0']
        for feature in ('shell_tool', 'multi_agent', 'apps', 'plugins', 'browser_use',
                        'computer_use', 'image_generation'):
            command += ['--disable', feature]
        if agent.effort:
            command += ['-c', f'model_reasoning_effort={json.dumps(agent.effort)}']
        for image in images or []:
            command += ['--image', image]
        command += ['-']
    elif agent.host == 'cursor':
        # Ask mode is read-only; no --force or automatic MCP approvals.
        command += ['--print', '--mode', 'ask', '--model', agent.model,
                    '--output-format', 'json', '--trust', '--workspace', str(work_dir)]
    else:
        command += ['-p', '--tools', '', *_model_flag(agent), '--output-format', 'json',
                    '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config',
                    '--mcp-config', '{"mcpServers":{}}']
        if agent.effort:
            command += ['--effort', agent.effort]
    return command


def ask_text(agent: AgentConfig, prompt: str, work_dir: Path, images: list[str] | None = None) -> str:
    """Run one bounded host-matched request and return only its final response text."""
    work_dir = Path(work_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    command = command_for(agent, work_dir, images)
    environment = {key: value for key, value in os.environ.items() if key != 'CLAUDECODE'}
    result = subprocess.run(command, input=prompt, encoding='utf-8', errors='replace',
                            capture_output=True, cwd=work_dir, env=environment, timeout=900,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    (work_dir / 'model-response.json').write_text(result.stdout, encoding='utf-8')
    (work_dir / 'model-stderr.log').write_text(result.stderr, encoding='utf-8')
    (work_dir / 'agent.json').write_text(json.dumps({
        'host': agent.host, 'model': agent.model, 'effort': agent.effort}), encoding='utf-8')
    if agent.host == 'codex':
        if result.returncode:
            detail = result.stderr.strip()[-600:]
            for line in result.stdout.splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get('type') in {'error', 'turn.failed'}:
                    detail = event.get('message') or (event.get('error') or {}).get('message') or detail
            raise RuntimeError(f'Codex request failed: {detail or result.returncode}')
        text = (work_dir / 'reply.txt').read_text(encoding='utf-8')
    else:
        try:
            envelope = json.loads(result.stdout)
        except ValueError:
            detail = result.stderr.strip()[-1200:] if result.returncode else ''
            raise RuntimeError(detail or f'{agent.label} returned no JSON. Check sign-in; details are in the worker log.') from None
        if not isinstance(envelope, dict):
            raise RuntimeError(f'{agent.label} returned an invalid response.')
        if result.returncode or envelope.get('is_error'):
            raise RuntimeError(str(envelope.get('result') or envelope.get('error') or f'{agent.label} request failed.'))
        text = json.dumps(envelope['structured_output']) if isinstance(envelope.get('structured_output'), dict) else envelope.get('result', '')
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError(f'{agent.label} returned no answer. Try again.')
    return text.strip()


def ask_json(agent: AgentConfig, prompt: str, work_dir: Path) -> dict:
    """Parse the worker's source extraction result without inventing missing output."""
    text = ask_text(agent, prompt, work_dir)
    if text.startswith('```') and text.endswith('```'):
        text = '\n'.join(text.splitlines()[1:-1])
    result = json.loads(text)
    if not isinstance(result, dict):
        raise ValueError('Extraction must return a JSON object.')
    return result
