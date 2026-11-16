import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { setDesktopLocale } from '../i18n/desktop-messages';
import { SettingsPage } from './settings-page';

@Component({ selector: 'app-dummy-child', template: '<p>child</p>' })
class DummyChildPage {}

describe('SettingsPage', () => {
  beforeEach(() => setDesktopLocale('zh-TW'));
  afterEach(() => setDesktopLocale('zh-TW'));

  // The layout is rendered by the router, as in the app, so its relative
  // links resolve against the settings route.
  async function setup(initialUrl = '/settings/engines') {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'settings',
            component: SettingsPage,
            children: [
              { path: '', pathMatch: 'full', redirectTo: 'engines' },
              { path: 'engines', component: DummyChildPage },
              { path: 'compute', component: DummyChildPage },
              { path: 'general', component: DummyChildPage },
              { path: 'diagnostics', component: DummyChildPage },
            ],
          },
        ]),
      ],
    });

    const harness = await RouterTestingHarness.create(initialUrl);
    return { harness, el: harness.routeNativeElement as HTMLElement };
  }

  it('renders the 設定 heading, labelled sub-navigation, and four links', async () => {
    const { el } = await setup();

    expect(el.querySelector('h1')?.textContent?.trim()).toBe('設定');
    const nav = el.querySelector('[data-testid="settings-subnav"]');
    expect(nav?.getAttribute('aria-label')).toBe('設定導覽');
    const links = [...(nav?.querySelectorAll('a') ?? [])];
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      '辨識功能',
      '運算裝置',
      '一般',
      '診斷',
    ]);
    expect(links.map((link) => link.getAttribute('data-testid'))).toEqual([
      'settings-nav-engines',
      'settings-nav-compute',
      'settings-nav-general',
      'settings-nav-diagnostics',
    ]);
  });

  it('marks the active entry with aria-current="page" when navigating', async () => {
    const { harness, el } = await setup('/settings/engines');

    expect(
      el.querySelector('[data-testid="settings-nav-engines"]')?.getAttribute('aria-current'),
    ).toBe('page');
    expect(
      el.querySelector('[data-testid="settings-nav-compute"]')?.getAttribute('aria-current'),
    ).toBeNull();

    await harness.navigateByUrl('/settings/compute');
    harness.detectChanges();

    expect(
      el.querySelector('[data-testid="settings-nav-compute"]')?.getAttribute('aria-current'),
    ).toBe('page');
    expect(
      el.querySelector('[data-testid="settings-nav-engines"]')?.getAttribute('aria-current'),
    ).toBeNull();
  });

  it('updates labels when switching to English', async () => {
    const { harness, el } = await setup();

    setDesktopLocale('en');
    harness.detectChanges();

    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Settings');
    expect(
      [...el.querySelectorAll('[data-testid="settings-subnav"] a')].map((link) =>
        link.textContent?.trim(),
      ),
    ).toEqual(['Recognition features', 'Compute', 'General', 'Diagnostics']);
  });
});
