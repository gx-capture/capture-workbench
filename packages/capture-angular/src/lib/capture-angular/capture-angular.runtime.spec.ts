import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CaptureWorkbenchComponent } from './capture-angular';
import { READY, fakeClient } from './capture-angular-test-support';

describe('CaptureWorkbenchComponent', () => {
  let fixture: ComponentFixture<CaptureWorkbenchComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CaptureWorkbenchComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(CaptureWorkbenchComponent);
  });

  it('applies source, size, and theme configuration', async () => {
    fixture.componentRef.setInput('client', fakeClient());
    fixture.componentRef.setInput('config', {
      width: '32rem',
      height: '24rem',
      theme: { accent: '#7c3aed' },
      enabledSources: ['image'],
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector(
      '.capture-workbench',
    ) as HTMLElement;
    const input = fixture.nativeElement.querySelector(
      'input[type=file]',
    ) as HTMLInputElement;
    expect(panel.style.width).toBe('32rem');
    expect(panel.style.height).toBe('24rem');
    expect(panel.style.getPropertyValue('--capture-accent')).toBe('#7c3aed');
    expect(input.accept).toContain('.png');
    expect(input.accept).not.toContain('.pdf');
  });

  it('reloads the runtime handshake through the resource signal', async () => {
    const client = fakeClient();
    fixture.componentRef.setInput('client', client);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.runtime().status).toBe('ready');
    expect(client.getReady).toHaveBeenCalledOnce();
    expect(client.getRequirements).toHaveBeenCalledOnce();

    fixture.componentInstance.refreshRuntime();
    await fixture.whenStable();

    expect(fixture.componentInstance.runtime().status).toBe('ready');
    expect(client.getReady).toHaveBeenCalledTimes(2);
    expect(client.getRequirements).toHaveBeenCalledTimes(2);
  });

  it('maps resource compatibility failures to the incompatible runtime state', async () => {
    const client = fakeClient({
      getReady: vi.fn(() => of({ ...READY, runtimeVersion: '1.0.0' })),
    });
    fixture.componentRef.setInput('client', client);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.runtime()).toMatchObject({
      status: 'incompatible',
      error: expect.stringContaining('incompatible'),
    });
  });

  it('maps resource handshake failures to the runtime error state', async () => {
    const client = fakeClient({
      getRequirements: vi.fn(() =>
        throwError(() => new Error('runtime probe failed')),
      ),
    });
    fixture.componentRef.setInput('client', client);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.runtime()).toMatchObject({
      status: 'error',
      error: 'runtime probe failed',
    });
  });

  it('still performs a handshake when runtime setup UI is hidden', async () => {
    const client = fakeClient();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('config', { showRuntimeSetup: false });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(client.getReady).toHaveBeenCalledOnce();
    expect(client.getRequirements).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('.runtime-card')).toBeNull();
  });

  it('skips its handshake only with explicit hostManagedHandshake', async () => {
    const client = fakeClient();
    fixture.componentRef.setInput('client', client);
    fixture.componentRef.setInput('config', {
      showRuntimeSetup: false,
      hostManagedHandshake: true,
    });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(client.getReady).not.toHaveBeenCalled();
    expect(client.getRequirements).not.toHaveBeenCalled();
  });
});
