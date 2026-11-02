import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  withComponentInputBinding,
} from '@angular/router';
import { App } from './app';
import { appRoutes } from './app.routes';
import { HistoryPage } from './history/history-page';
import { setDesktopLocale } from './i18n/desktop-messages';
import { DesktopWorkspaceStore } from './services/desktop-workspace.store';

describe('App shell', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));

  it('starts the workspace once and lists the four pages in Traditional Chinese', async () => {
    const { fixture, store } = await renderShell('/');

    expect(store.initialize).toHaveBeenCalledTimes(1);
    const links = [
      ...fixture.nativeElement.querySelectorAll('[data-testid="shell-nav"] a'),
    ] as HTMLAnchorElement[];
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      '文件轉文字',
      '錄音轉逐字稿',
      '紀錄',
      '設定',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/ocr',
      '/asr',
      '/history',
      '/settings',
    ]);
  });

  it('opens document to text by default and marks its link as the current page', async () => {
    const { fixture } = await renderShell('/');

    expect(TestBed.inject(Router).url).toBe('/ocr');
    expect(
      fixture.nativeElement.querySelector('[data-testid="page-ocr"] h1')
        ?.textContent,
    ).toContain('文件轉文字');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="nav-ocr"]')
        ?.getAttribute('aria-current'),
    ).toBe('page');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="nav-asr"]')
        ?.getAttribute('aria-current'),
    ).toBeNull();
  });

  it.each([
    ['/asr', 'page-asr', '錄音轉逐字稿', '前往紀錄加入錄音'],
    ['/settings', 'page-settings', '設定', '前往紀錄調整設定'],
  ])(
    'renders %s as a page that leads to the history page',
    async (url, testId, title, action) => {
      const { fixture } = await renderShell(url);

      const page = fixture.nativeElement.querySelector(
        `[data-testid="${testId}"]`,
      ) as HTMLElement;
      expect(page.querySelector('h1')?.textContent).toContain(title);
      expect(page.textContent).toContain('即將推出');
      const link = page.querySelector('a[href="/history"]');
      expect(link?.textContent?.trim()).toBe(action);
    },
  );

  it('keeps the existing workspace on the history route and sends unknown paths home', async () => {
    expect(appRoutes.find((route) => route.path === 'history')?.component).toBe(
      HistoryPage,
    );
    await renderShell('/no-such-page');

    expect(TestBed.inject(Router).url).toBe('/ocr');
  });

  it('shows the runtime state at the bottom of the navigation', async () => {
    const { fixture, store } = await renderShell('/');
    const status = () =>
      fixture.nativeElement.querySelector(
        '[data-testid="runtime-status"]',
      ) as HTMLElement;

    expect(status().dataset['state']).toBe('starting');
    expect(status().textContent).toContain('尚未就緒');

    store.state.set('ready');
    fixture.detectChanges();
    expect(status().dataset['state']).toBe('ready');
    expect(status().textContent).toContain('已就緒');
  });
});

async function renderShell(url: string) {
  const store = {
    state: signal<'starting' | 'needs-setup' | 'ready' | 'error'>('starting'),
    initialize: vi.fn(),
  };
  await TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(appRoutes, withComponentInputBinding()),
      { provide: DesktopWorkspaceStore, useValue: store },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  await TestBed.inject(Router).navigateByUrl(url);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, store };
}
