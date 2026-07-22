import { TestBed } from '@angular/core/testing';
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
  });
});
