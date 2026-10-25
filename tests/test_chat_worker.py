"""The watcher acknowledges only captured turns and preserves the Viewer conversation."""
import json
import threading

from test_literature_catalog import _write_run
from lib.chat import append_message, load_chat, pending_by_paper


def _fixture(tmp_path, monkeypatch, ask):
    from lib.agent_runtime import AgentConfig
    from lib.chat_worker import ChatWatcher
    monkeypatch.setattr('lib.agent_runtime.shutil.which', lambda name: name + '.exe')
    run = _write_run(tmp_path, web=True)
    (run / 'cleaned_jsons/p_one.json').write_text(json.dumps({'pages': [
        {'page': 1, 'text': 'The source states X is Y.'}]}), encoding='utf-8')
    watcher = ChatWatcher(run, AgentConfig('cursor', 'gpt-6-astra'), ask=ask, interval=0.01)
    return run, watcher


def test_saved_turn_and_later_message_both_receive_replies(tmp_path, monkeypatch):
    entered, release, second = threading.Event(), threading.Event(), threading.Event()
    prompts = []
    def ask(agent, prompt, work, images=None):
        prompts.append(prompt)
        if len(prompts) == 1:
            entered.set()
            assert release.wait(5)
            return 'First answer.'
        second.set()
        return 'Second answer.'
    run, watcher = _fixture(tmp_path, monkeypatch, ask)
    first = append_message(run, '_workspace', role='user', text='Explain X.',
        context={'sources': [{'paper_id': 'p_one', 'page': 1}]},
        attachments=[{'paper_id': 'p_one', 'page': 1, 'text': 'X is Y'}])
    watcher.start()
    try:
        assert entered.wait(5)
        assert watcher.status('_workspace')['responding_to'] == first['id']
        later = append_message(run, '_workspace', role='user', text='And why?',
            context={'sources': [{'paper_id': 'p_one'}]})
        watcher.notify('_workspace', later)
        watcher.notify('_workspace', later)
        release.set()
        assert second.wait(5)
        assert watcher.wait_idle(5)
        messages = load_chat(run, '_workspace')['messages']
        replies = [m for m in messages if m['role'] == 'assistant']
        assert [m['in_reply_to'] for m in replies] == [first['id'], later['id']]
        assert all(m['agent'] == 'Cursor' for m in replies)
        assert not pending_by_paper(run)
        assert 'The source states X is Y.' in prompts[0]
        assert 'And why?' not in prompts[0]
        assert 'First answer.' in prompts[1] and 'Explain X.' in prompts[1]
        assert len(prompts) == 2
    finally:
        release.set()
        watcher.close()
    assert not watcher.status('_workspace')['watching']


def test_failed_turn_is_reported_once_and_next_turn_retries(tmp_path, monkeypatch):
    attempted = threading.Event()
    calls = []
    def ask(*args, **kwargs):
        calls.append(1)
        attempted.set()
        if len(calls) == 1:
            raise RuntimeError('Sign in to Cursor and send again.')
        return 'Recovered.'
    run, watcher = _fixture(tmp_path, monkeypatch, ask)
    append_message(run, '_workspace', role='user', text='Hello')
    watcher.start()
    try:
        assert attempted.wait(5) and watcher.wait_idle(5)
        assert not pending_by_paper(run)
        assert 'Sign in' in load_chat(run, '_workspace')['messages'][-1]['text']
        attempted.clear()
        message = append_message(run, '_workspace', role='user', text='Try again')
        watcher.notify('_workspace', message)
        assert attempted.wait(5) and watcher.wait_idle(5)
        assert load_chat(run, '_workspace')['messages'][-1]['text'] == 'Recovered.'
        assert len(calls) == 2
    finally:
        watcher.close()


def test_missing_model_never_claims_to_be_listening(tmp_path):
    from lib.agent_runtime import AgentConfig
    from lib.chat_worker import ChatWatcher
    watcher = ChatWatcher(tmp_path, AgentConfig('cursor'))
    watcher.start()
    assert watcher.status('_workspace')['watching'] is False
    assert '--model' in watcher.status('_workspace')['error']
    watcher.close()


def test_manual_reply_during_generation_prevents_duplicate(tmp_path, monkeypatch):
    def ask(*args, **kwargs):
        append_message(run, '_workspace', role='assistant', text='Already answered.',
                       in_reply_to=question['id'], agent='Cursor')
        return 'Duplicate.'
    run, watcher = _fixture(tmp_path, monkeypatch, ask)
    question = append_message(run, '_workspace', role='user', text='Hello')
    watcher.start()
    try:
        assert watcher.wait_idle(5)
        assert [m['text'] for m in load_chat(run, '_workspace')['messages']] == ['Hello', 'Already answered.']
    finally:
        watcher.close()


def test_a_transient_read_error_does_not_stop_the_listener(tmp_path, monkeypatch):
    from lib import chat_worker
    answered = threading.Event()
    def ask(agent, prompt, work, images=None):
        answered.set()
        return 'Answer.'
    run, watcher = _fixture(tmp_path, monkeypatch, ask)
    real, failures = chat_worker.pending_by_paper, []
    def flaky(path):
        if not failures:
            failures.append(1)
            raise PermissionError('chat file locked by another process')
        return real(path)
    monkeypatch.setattr(chat_worker, 'pending_by_paper', flaky)
    append_message(run, '_workspace', role='user', text='Explain X.',
        context={'sources': [{'paper_id': 'p_one', 'page': 1}]})
    watcher.start()
    try:
        assert answered.wait(5)
        assert watcher.status('_workspace')['watching']
    finally:
        watcher.close()


def test_a_read_error_while_saving_the_reply_does_not_lose_it(tmp_path, monkeypatch):
    from lib import chat_worker
    run, watcher = _fixture(tmp_path, monkeypatch, lambda agent, prompt, work, images=None: 'Answer.')
    real, calls = chat_worker.pending_by_paper, []
    def flaky(path):
        calls.append(1)
        if len(calls) == 2:  # the scan just before the reply is saved
            raise PermissionError('chat file locked by another process')
        return real(path)
    monkeypatch.setattr(chat_worker, 'pending_by_paper', flaky)
    append_message(run, '_workspace', role='user', text='Explain X.',
        context={'sources': [{'paper_id': 'p_one', 'page': 1}]})
    watcher.start()
    try:
        assert watcher.wait_idle(5)
        replies = [m for m in load_chat(run, '_workspace')['messages'] if m['role'] == 'assistant']
        assert [m['text'] for m in replies] == ['Answer.']
        assert watcher.status('_workspace')['watching']
    finally:
        watcher.close()
