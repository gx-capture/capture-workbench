import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { InstallProgress } from './install-progress';

function render(installation: {
  progress: number;
  downloadedBytes?: number | null;
  downloadBytes?: number | null;
} | null) {
  const fixture = TestBed.createComponent(InstallProgress);
  fixture.componentRef.setInput('installation', installation);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const bar = root.querySelector('[data-testid="install-progress-bar"]') as HTMLElement;
  return {
    label: root.querySelector('[data-testid="install-progress-label"]')?.textContent?.trim(),
    phase: bar.getAttribute('data-phase'),
    now: bar.getAttribute('aria-valuenow'),
    name: bar.getAttribute('aria-label'),
    fill: (bar.firstElementChild as HTMLElement).style.transform,
    pulsing: (bar.firstElementChild as HTMLElement).classList.contains('animate-pulse'),
  };
}

describe('InstallProgress', () => {
  it('says it is preparing and shows no figure while the start request is in flight', () => {
    const view = render(null);
    expect(view.label).toBe('正在準備安裝…');
    expect(view.phase).toBe('preparing');
    expect(view.now).toBeNull();
    expect(view.pulsing).toBe(true);
  });

  it('shows the downloaded share as a figure and as the bar', () => {
    const view = render({ progress: 0.2, downloadedBytes: 370, downloadBytes: 1000 });
    expect(view.label).toBe('正在下載 37%');
    expect(view.phase).toBe('downloading');
    expect(view.now).toBe('37');
    expect(view.name).toBe('正在下載 37%');
    expect(view.fill).toBe('scaleX(0.37)');
    expect(view.pulsing).toBe(false);
  });

  it('says the download is complete once every byte has arrived, instead of staying at 100 %', () => {
    const view = render({ progress: 0.845, downloadedBytes: 1000, downloadBytes: 1000 });
    expect(view.label).toBe('下載完成，正在安裝…');
    expect(view.phase).toBe('installing');
    expect(view.now).toBeNull();
    expect(view.fill).toBe('scaleX(1)');
    expect(view.pulsing).toBe(true);
  });
});
