"""Opt-in real Chromium checks; CRUX_BROWSER_ASSETS supplies the pinned CDN scripts."""
import io
import json
import os
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from test_literature_pane_api import _server
from lib.sources import scaffold_folder


@pytest.fixture
def reader(tmp_path, request):
    assets = os.environ.get('CRUX_BROWSER_ASSETS')
    if not assets:
        pytest.skip('Set CRUX_BROWSER_ASSETS to the pinned PDF.js and markdown-it scripts')
    from playwright.sync_api import sync_playwright
    writer = PdfWriter()
    for dark in (True, False):
        page = writer.add_blank_page(width=400, height=500)
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({
            NameObject('/F1'): DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})})})
        stream = DecodedStreamObject()
        stream.set_data((f'{0 if dark else 1} g 0 0 400 500 re f\n'
                         f'{1 if dark else 0} g BT /F1 24 Tf 40 370 Td (Readable evidence) Tj ET').encode())
        page[NameObject('/Contents')] = writer._add_object(stream)
        page.rotate(90)
    param = getattr(request, 'param', 2)  # a page count, or 'labelled' for a book's own numbering
    pages = 60 if param == 'labelled' else param
    for _ in range(pages - 2):
        writer.add_blank_page(width=400, height=500)
    if param == 'labelled':  # front matter i, ii, then the body numbered from 1
        writer.set_page_label(0, 1, style='/r')
        writer.set_page_label(2, pages - 1, style='/D', start=1)
    writer.write(tmp_path / 'contrast.pdf')
    run = scaffold_folder(tmp_path)
    server, port = _server(run)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        def route(request):
            name = request.request.url.rsplit('/', 1)[-1]
            path = Path(assets) / name
            if path.is_file():
                request.fulfill(path=str(path), content_type='application/javascript')
            else:
                request.abort()
        context.route('https://**/*', route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(f'http://127.0.0.1:{port}/view/contrast')
            frame = page.frame_locator('#reader-left')
            frame.locator('.textLayer span').first.wait_for()
            page.wait_for_function('document.querySelector("#reader-left").contentWindow.cruxReader')
            yield page, frame, run, errors
        finally:
            browser.close()
            server.shutdown()
            server.server_close()


READER_WIN = 'document.querySelector("#reader-left").contentWindow'


def test_back_arrow_is_disabled_until_the_reader_jumps(reader):
    page, frame, run, errors = reader
    back = frame.locator('#pdf-back-loc')
    assert back.get_attribute('title') == 'Previous location'
    assert back.is_disabled(), 'nothing to undo before the first jump'
    frame.locator('#pdf-next').click()
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 2')
    assert back.is_enabled()
    assert not errors


def test_back_arrow_undoes_the_last_jump_and_leaves_the_library_alone(reader):
    page, frame, run, errors = reader
    well = frame.locator('#doc-well')
    start = well.evaluate('el => el.scrollTop')
    frame.locator('#pdf-next').click()
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 2')
    page.wait_for_function(f'{READER_WIN}.document.querySelector("#doc-well").scrollTop > 100')
    frame.locator('#pdf-back-loc').click(timeout=2000)
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 1', timeout=5000)
    assert abs(well.evaluate('el => el.scrollTop') - start) <= 2
    assert frame.locator('#pdf-back-loc').is_disabled(), 'the stack is empty again'
    assert page.locator('#library').is_hidden(), 'the arrow is not the Library button'
    page.locator('#library-toggle').click()
    assert page.locator('#library').is_visible(), 'the Library stays reachable from the rail'
    assert frame.locator('.pdf-page').count() == 2
    assert not errors


def test_back_arrow_undoes_a_typed_page_in_one_click(reader):
    page, frame, run, errors = reader
    field = frame.locator('#pdf-page')
    field.fill('2')
    field.press('Enter')  # Enter also blurs the field, which re-runs the same jump
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 2')
    page.wait_for_function(f'{READER_WIN}.document.querySelector("#doc-well").scrollTop > 100')
    frame.locator('#pdf-back-loc').click(timeout=2000)
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 1', timeout=5000)
    assert frame.locator('#pdf-back-loc').is_disabled(), 'one jump, one undo'
    assert not errors


def _single_page_mode(page):
    page.evaluate(f'{READER_WIN}.document.querySelector("[data-fit=single]").click()')
    page.wait_for_function(f'{READER_WIN}.document.querySelectorAll(".pdf-page").length === 1')


def test_back_arrow_rerenders_the_remembered_page_in_single_mode(reader):
    page, frame, run, errors = reader
    _single_page_mode(page)
    frame.locator('#pdf-next').click()
    page.wait_for_function(f'{READER_WIN}.document.querySelector(".pdf-page")?.dataset.page === "2"')
    frame.locator('#pdf-back-loc').click(timeout=2000)
    page.wait_for_function(f'{READER_WIN}.document.querySelector(".pdf-page")?.dataset.page === "1"', timeout=5000)
    assert frame.locator('#pdf-back-loc').is_disabled()
    assert not errors


def test_back_arrow_undoes_a_typed_page_in_one_click_in_single_mode(reader):
    page, frame, run, errors = reader
    _single_page_mode(page)
    field = frame.locator('#pdf-page')
    field.fill('2')
    field.press('Enter')  # the blur repeat arrives while page 2 is still rendering
    page.wait_for_function(f'{READER_WIN}.document.querySelector(".pdf-page")?.dataset.page === "2"')
    frame.locator('#pdf-back-loc').click(timeout=2000)
    page.wait_for_function(f'{READER_WIN}.document.querySelector(".pdf-page")?.dataset.page === "1"', timeout=5000)
    assert frame.locator('#pdf-back-loc').is_disabled(), 'one jump, one undo'
    assert not errors


def test_two_back_clicks_during_a_render_land_in_order_in_single_mode(reader):
    page, frame, run, errors = reader
    _single_page_mode(page)
    frame.locator('#pdf-next').click()
    page.wait_for_function(f'{READER_WIN}.document.querySelector(".pdf-page")?.dataset.page === "2"')
    # the fixture has two pages, so the second jump is a typed return to page 1: 1 -> 2 -> 1
    field = frame.locator('#pdf-page')
    field.fill('1')
    field.press('Enter')
    page.wait_for_function(f'{READER_WIN}.document.querySelector(".pdf-page")?.dataset.page === "1"')
    # two clicks in one task: the second arrives while the first is still rendering page 2
    page.evaluate(f'() => {{ const b = {READER_WIN}.document.getElementById("pdf-back-loc"); b.click(); b.click(); }}')
    page.wait_for_function(f'{READER_WIN}.document.querySelector(".pdf-page")?.dataset.page === "1"'
                           f' && {READER_WIN}.document.getElementById("pdf-page").value === "1"'
                           f' && {READER_WIN}.document.getElementById("pdf-back-loc").disabled', timeout=5000)
    page.wait_for_timeout(500)
    assert frame.locator('.pdf-page').count() == 1
    assert frame.locator('.pdf-page').first.get_attribute('data-page') == '1'
    assert not errors


def test_back_arrow_unwinds_jumps_in_order_and_ignores_hand_scrolling(reader):
    page, frame, run, errors = reader
    well = frame.locator('#doc-well')
    back = frame.locator('#pdf-back-loc')
    well.evaluate('el => { el.scrollTop = 120; }')
    page.wait_for_timeout(300)
    assert back.is_disabled(), 'hand scrolling is not a jump'
    frame.locator('#pdf-next').click()
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 2')
    page.wait_for_timeout(700)  # the smooth jump settles within 520 ms
    second = well.evaluate('el => { el.scrollTop += 40; return el.scrollTop; }')
    page.wait_for_timeout(300)
    frame.locator('#pdf-prev').click()
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 1')
    page.wait_for_timeout(700)
    back.click(timeout=2000)
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 2', timeout=5000)
    assert abs(well.evaluate('el => el.scrollTop') - second) <= 2, 'newest jump first, hand scroll included'
    back.click(timeout=2000)
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 1', timeout=5000)
    assert abs(well.evaluate('el => el.scrollTop') - 120) <= 2
    assert back.is_disabled()
    assert not errors


def test_uploaded_pdf_banks_recorded_claim_and_refreshes_reader(reader, monkeypatch):
    from lib import extraction
    page, frame, run, errors = reader
    if extraction.extractor_root() is None:
        pytest.skip('Set CRUX_CLAIMS_ROOT to an installed claim-extractor skill')
    monkeypatch.setattr(extraction.ExtractionJobs, '_availability', lambda *args: (True, ''))
    def recorded_result(prompt, work_dir, *args):
        source = json.loads(next(work_dir.glob('*.json')).read_text(encoding='utf-8'))
        return {'paper_id': source['paper_id'], 'title': 'Recorded evidence', 'gist': 'Fixture evidence.',
                'claims': [{'kind': 'finding', 'statement': 'The page contains readable evidence.',
                    'quotes': [{'text': 'Readable evidence', 'locator': {'paper': source['paper_id'], 'page': 1}}],
                    'attribution': {'basis': 'direct', 'rationale': None, 'references': []}}]}
    monkeypatch.setattr(extraction, 'ask_model', recorded_result)
    page.goto(page.url.split('/view/')[0] + '/')
    page.locator('#add-pdf').set_input_files({'name': 'imported.pdf', 'mimeType': 'application/pdf',
                                           'buffer': (run.parent / 'contrast.pdf').read_bytes()})
    page.wait_for_url('**/view/imported')
    page.wait_for_function('''() => {
      const reader = document.querySelector('#reader-left')?.contentWindow?.cruxReader;
      return reader?.paper.claims.length === 1;
    }''', timeout=15000)
    # the button follows its own status poll, which can land just after the claims
    page.wait_for_function("document.querySelector('#extract-claims').innerText === 'Re-extract claims'", timeout=10000)
    rows = [json.loads(line) for line in (run / 'claims.jsonl').read_text(encoding='utf-8').splitlines()]
    assert len(rows) == 1 and rows[0]['paper_id'] == 'imported'
    assert rows[0]['quotes'][0]['text'] == 'Readable evidence'
    assert not errors


def test_rotation_preserves_pdf_orientation_and_returns_after_four_turns(reader):
    page, frame, run, errors = reader
    canvas = frame.locator('.pdf-page canvas').first
    initial = canvas.bounding_box()
    assert initial['width'] > initial['height'], 'The source /Rotate=90 was discarded'
    for turn in range(1, 5):
        frame.locator('#pdf-rotate').click()
        page.wait_for_function('''expected => {
          const w = document.querySelector('#reader-left').contentWindow;
          const c = w.document.querySelector('.pdf-page canvas');
          return w.cruxReader.snapshot().rotation === expected && c &&
            (c.width > c.height) === (expected % 180 === 0);
        }''', arg=(turn * 90) % 360)
    final = canvas.bounding_box()
    assert final['width'] == pytest.approx(initial['width'])
    assert final['height'] == pytest.approx(initial['height'])
    assert not errors


@pytest.mark.parametrize('page_index', [0, 1], ids=['white-on-black', 'black-on-white'])
def test_highlight_keeps_text_readable(reader, tmp_path, page_index):
    from PIL import Image
    page, frame, run, errors = reader
    target = frame.locator('.pdf-page').nth(page_index)
    before = Image.open(io.BytesIO(target.screenshot())).convert('RGB')
    frame.locator('body').evaluate('''(element, page) => cruxReader.applyMarks([
      {id: 'contrast-mark', type: 'highlight', page, ink: 'yellow', start: 0, end: 17}
    ])''', page_index + 1)
    frame.locator('.user-hl').first.click()
    after = Image.open(io.BytesIO(target.screenshot())).convert('RGB')
    def luminance(rgb):
        linear = [v / 3294.6 if v <= 10 else ((v / 255 + .055) / 1.055) ** 2.4 for v in rgb]
        return sum(v * weight for v, weight in zip(linear, (.2126, .7152, .0722)))
    # The unmarked PDF supplies glyph/background masks independent of the CSS.
    pairs = list(zip(zip(*[iter(before.tobytes())] * 3), zip(*[iter(after.tobytes())] * 3)))
    foreground = [luminance(new) for old, new in pairs
                  if (min(old) > 250 if page_index == 0 else max(old) < 5) and new != old]
    background = [luminance(new) for old, new in pairs
                  if (max(old) < 5 if page_index == 0 else min(old) > 250)
                  and new[0] > 50 and new[1] > 50 and new[2] < new[0] * .8]
    assert foreground and background, 'No visible highlight on the source text'
    levels = sorted([sorted(foreground)[len(foreground)//2], sorted(background)[len(background)//2]])
    ratio = (levels[1] + .05) / (levels[0] + .05)
    page.screenshot(path=str(tmp_path / 'highlights.png'))
    assert ratio >= 4.5, f'Highlighted text contrast is {ratio:.2f}:1'
    assert not errors


def test_overlapping_quotes_paint_on_a_web_source(tmp_path, monkeypatch):
    assets = os.environ.get('CRUX_BROWSER_ASSETS')
    if not assets:
        pytest.skip('Set CRUX_BROWSER_ASSETS to the pinned PDF.js and markdown-it scripts')
    import serve_literature
    from playwright.sync_api import sync_playwright
    from test_literature_catalog import _write_run
    run = _write_run(tmp_path, web=True)
    (run / 'cleaned_jsons' / 'p_one.json').write_text(json.dumps({'pages': [{'page': 1, 'text': 'Before. X is Y on the page today. After.'}]}))
    (run / 'claims.jsonl').write_text(''.join(json.dumps({'id': f'clm_p_one_000{i}', 'paper_id': 'p_one', 'kind': 'finding',
        'statement': text, 'quotes': [{'text': text, 'locator': {'paper': 'p_one', 'page': 1}}]}) + '\n'
        for i, text in enumerate(['X is Y on the page', 'on the page today'], 1)))
    monkeypatch.setattr(serve_literature, '_fetch_live', lambda url: (_ for _ in ()).throw(serve_literature.urllib.error.URLError('offline')))
    server, port = _server(run)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page()
        def route(request):
            path = Path(assets) / request.request.url.rsplit('/', 1)[-1]
            request.fulfill(path=str(path), content_type='application/javascript') if path.is_file() else request.abort()
        page.route('https://**/*', route)
        try:
            page.goto(f'http://127.0.0.1:{port}/view/p_one')
            frame = page.frame_locator('#reader-left')
            frame.locator('#status', has_text='example.org').wait_for(timeout=10000)
            page.locator('#tab-claims').click()
            assert page.locator('#claims article.claim').count() == 2
            assert page.locator('#claims article.claim.missed').count() == 0
        finally:
            browser.close()
            server.shutdown()
            server.server_close()


@pytest.mark.parametrize('reader', [60], indirect=True)
def test_a_long_pdf_draws_only_the_pages_near_the_view(reader):
    page, frame, run, errors = reader
    rendered = f'{READER_WIN}.document.getElementById("status").textContent === "60 pages"'
    drawn = f'[...{READER_WIN}.document.querySelectorAll(".pdf-page canvas")].filter(c => c.width).length'
    page.wait_for_function(rendered, timeout=60000)
    assert 0 < page.evaluate(drawn) <= 12, 'every page of a long PDF holds a full-size canvas'
    frame.locator('#pdf-zoom-in').click()
    page.wait_for_timeout(500)  # the zoom re-render starts after a short debounce
    page.wait_for_function(rendered, timeout=60000)
    frame.locator('#doc-well').evaluate('well => { well.scrollTop = well.scrollHeight; }')
    last = f'{READER_WIN}.document.querySelector(".pdf-page[data-page=\'60\'] canvas").width > 0'
    page.wait_for_function(last, timeout=15000)
    assert 0 < page.evaluate(drawn) <= 12
    assert not errors


ZOOM = f'{READER_WIN}.document.getElementById("pdf-zoom").value'


def _set_zoom(page, frame, text):
    frame.locator('#pdf-zoom').fill(text)
    frame.locator('#pdf-zoom').press('Enter')
    page.wait_for_function(f'{ZOOM} === "{text}"')


def test_zoom_in_goes_past_400_percent(reader):
    page, frame, run, errors = reader
    _set_zoom(page, frame, '400%')
    frame.locator('#pdf-zoom-in').click()
    page.wait_for_function(f'{ZOOM} === "460%"', timeout=10000)
    assert not errors


def test_zoom_clicks_during_a_render_each_count(reader):
    page, frame, run, errors = reader
    _set_zoom(page, frame, '100%')
    frame.locator('#pdf-zoom-in').evaluate('button => { button.click(); button.click(); }')
    page.wait_for_function(f'{ZOOM} === "132%"', timeout=10000)
    assert not errors


@pytest.mark.parametrize('reader', ['labelled'], indirect=True)
def test_page_box_shows_and_accepts_the_books_own_page_numbers(reader):
    page, frame, run, errors = reader
    page.wait_for_function(f'{READER_WIN}.document.getElementById("status").textContent === "60 pages"', timeout=60000)
    assert frame.locator('#pdf-page').input_value() == 'i'
    assert frame.locator('#pdf-page-count').inner_text() == '(1 of 60)'
    frame.locator('#pdf-page').fill('10')
    frame.locator('#pdf-page').press('Enter')
    page.wait_for_function(f'{READER_WIN}.cruxReader.page === 12')
    assert frame.locator('#pdf-page').input_value() == '10'
    assert frame.locator('#pdf-page-count').inner_text() == '(12 of 60)'
    assert not errors
