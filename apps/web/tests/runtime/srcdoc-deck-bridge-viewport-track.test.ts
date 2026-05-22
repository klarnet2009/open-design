// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

function extractDeckBridgeScript(srcdoc: string): string {
  const match = srcdoc.match(/<script data-od-deck-bridge>([\s\S]*?)<\/script>/);
  if (!match || !match[1]) {
    throw new Error('deck bridge script not found in srcdoc');
  }
  return match[1];
}

function setupViewportTrackDeck() {
  const bodyHtml = `
    <div id="deck" style="position: fixed; inset: 0; display: flex; width: 300vw; transform: translateX(0);">
      <section class="slide active" style="width: 100vw; height: 100vh; flex: 0 0 100vw;">One</section>
      <section class="slide" style="width: 100vw; height: 100vh; flex: 0 0 100vw;">Two</section>
      <section class="slide" style="width: 100vw; height: 100vh; flex: 0 0 100vw;">Three</section>
    </div>
    <nav>
      <button class="dot active" type="button">1</button>
      <button class="dot" type="button">2</button>
      <button class="dot" type="button">3</button>
    </nav>
    <div class="deck-progress"><span class="bar" style="width: 33.3333%;"></span></div>`;
  const srcdoc = buildSrcdoc(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    deck: true,
  });
  const script = extractDeckBridgeScript(srcdoc);
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const parentPostMessage = vi.fn();
  const scrollTo = vi.fn();

  Object.defineProperty(win, 'innerWidth', { configurable: true, value: 1000 });
  Object.defineProperty(win, 'parent', {
    configurable: true,
    value: { postMessage: parentPostMessage },
  });
  Object.defineProperty(win.document.body, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(win.document.body, 'scrollWidth', { configurable: true, value: 3000 });
  Object.defineProperty(win.document.body, 'scrollLeft', { configurable: true, value: 0 });
  Object.defineProperty(win.document.body, 'scrollTo', { configurable: true, value: scrollTo });

  const evaluate = new win.Function(script);
  evaluate.call(win);

  let activeIndex = 0;
  function applySlide(index: number) {
    activeIndex = Math.max(0, Math.min(2, index));
    const deck = win.document.getElementById('deck') as HTMLElement;
    const slides = Array.from(win.document.querySelectorAll<HTMLElement>('.slide'));
    const dots = Array.from(win.document.querySelectorAll<HTMLElement>('.dot'));
    const progress = win.document.querySelector<HTMLElement>('.deck-progress .bar');

    deck.style.transform = `translateX(${-activeIndex * 100}vw)`;
    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle('active', slideIndex === activeIndex);
    });
    dots.forEach((dot, dotIndex) => {
      dot.classList.toggle('active', dotIndex === activeIndex);
    });
    if (progress) progress.style.width = `${((activeIndex + 1) / slides.length) * 100}%`;
  }
  win.document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') applySlide(activeIndex + 1);
    if (event.key === 'ArrowLeft') applySlide(activeIndex - 1);
  });

  return { win, scrollTo };
}

function setupLockedViewportTrackDeck() {
  const bodyHtml = `
    <div id="deck" style="position: fixed; inset: 0; display: flex; width: 300vw; transform: translateX(0);">
      <section class="slide active dark" data-theme="dark" style="width: 100vw; height: 100vh; flex: 0 0 100vw;">One</section>
      <section class="slide light" data-theme="light" style="width: 100vw; height: 100vh; flex: 0 0 100vw;">Two</section>
      <section class="slide dark" data-theme="dark" style="width: 100vw; height: 100vh; flex: 0 0 100vw;">Three</section>
    </div>
    <nav>
      <button class="dot active" type="button">1</button>
      <button class="dot" type="button">2</button>
      <button class="dot" type="button">3</button>
    </nav>`;
  const srcdoc = buildSrcdoc(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    deck: true,
  });
  const script = extractDeckBridgeScript(srcdoc);
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const parentPostMessage = vi.fn();
  const scrollTo = vi.fn();

  Object.defineProperty(win, 'innerWidth', { configurable: true, value: 1000 });
  Object.defineProperty(win, 'parent', {
    configurable: true,
    value: { postMessage: parentPostMessage },
  });
  Object.defineProperty(win.document.body, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(win.document.body, 'scrollWidth', { configurable: true, value: 3000 });
  Object.defineProperty(win.document.body, 'scrollLeft', { configurable: true, value: 0 });
  Object.defineProperty(win.document.body, 'scrollTo', { configurable: true, value: scrollTo });

  const evaluate = new win.Function(script);
  evaluate.call(win);

  let activeIndex = 0;
  let locked = false;
  function applySlide(index: number) {
    if (locked) return;
    activeIndex = Math.max(0, Math.min(2, index));
    const deck = win.document.getElementById('deck') as HTMLElement;
    const slides = Array.from(win.document.querySelectorAll<HTMLElement>('.slide'));
    const dots = Array.from(win.document.querySelectorAll<HTMLElement>('.dot'));

    deck.style.transform = `translateX(${-activeIndex * 100}vw)`;
    slides.forEach((slide, slideIndex) => {
      slide.classList.toggle('active', slideIndex === activeIndex);
    });
    dots.forEach((dot, dotIndex) => {
      dot.classList.toggle('active', dotIndex === activeIndex);
    });
    const theme = slides[activeIndex]?.dataset.theme ?? 'dark';
    win.document.body.classList.toggle('light-bg', theme === 'light');
    locked = true;
  }
  win.document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') applySlide(activeIndex + 1);
    if (event.key === 'ArrowLeft') applySlide(activeIndex - 1);
    if (event.key === 'Home') applySlide(0);
    if (event.key === 'End') applySlide(2);
  });

  return { win, scrollTo };
}

describe('deck bridge — fixed viewport transform tracks (#1531)', () => {
  it('drives 100vw fixed tracks with translateX instead of document scrolling', () => {
    const { win, scrollTo } = setupViewportTrackDeck();
    const deck = win.document.getElementById('deck') as HTMLElement;
    const slides = Array.from(win.document.querySelectorAll<HTMLElement>('.slide'));
    const dots = Array.from(win.document.querySelectorAll<HTMLElement>('.dot'));
    const progress = win.document.querySelector<HTMLElement>('.deck-progress .bar');

    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'od:slide', action: 'next' },
    }));

    expect(scrollTo).not.toHaveBeenCalled();
    expect(deck.style.transform).toBe('translateX(-100vw)');
    expect(slides.map((slide) => slide.classList.contains('active'))).toEqual([false, true, false]);
    expect(dots.map((dot) => dot.classList.contains('active'))).toEqual([false, true, false]);
    expect(progress?.style.width).toBe('66.66666666666666%');
  });

  it('uses authored endpoint navigation instead of repeated arrows for locked track jumps', () => {
    const { win, scrollTo } = setupLockedViewportTrackDeck();
    const deck = win.document.getElementById('deck') as HTMLElement;
    const slides = Array.from(win.document.querySelectorAll<HTMLElement>('.slide'));
    const dots = Array.from(win.document.querySelectorAll<HTMLElement>('.dot'));

    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'od:slide', action: 'go', index: 2 },
    }));

    expect(scrollTo).not.toHaveBeenCalled();
    expect(deck.style.transform).toBe('translateX(-200vw)');
    expect(slides.map((slide) => slide.classList.contains('active'))).toEqual([false, false, true]);
    expect(dots.map((dot) => dot.classList.contains('active'))).toEqual([false, false, true]);
    expect(win.document.body.classList.contains('light-bg')).toBe(false);
  });
});
