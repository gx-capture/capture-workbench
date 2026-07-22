import { TestBed } from '@angular/core/testing';
import { CAPTURE_STRUCTURING_PROVIDER } from '@wodenwang820118/capture-angular';
import { App } from './app';
import { appConfig } from './app.config';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: appConfig.providers,
    }).compileComponents();
  });

  it('renders the validation host and packaged component', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain(
      'Packaged workflow validation host',
    );
    expect(compiled.querySelector('capture-workbench')).not.toBeNull();
    expect(compiled.querySelector('.client-mode')?.getAttribute('data-client-mode')).toBe(
      'browser-unconfigured',
    );
    expect(
      Array.from(compiled.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Host provider interface',
      ),
    ).toBe(false);
    expect(TestBed.inject(CAPTURE_STRUCTURING_PROVIDER, null)).toBeNull();
  });

  it('cannot switch an unconfigured browser to host structuring', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      readonly config: () => { readonly structuringMode: string };
      selectMode(mode: 'runtime' | 'host'): void;
    };

    app.selectMode('host');

    expect(app.config().structuringMode).toBe('runtime');
  });
});
