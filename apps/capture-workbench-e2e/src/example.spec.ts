import { expect, test, type Page } from '@playwright/test';

test('shows one explicit Traditional Chinese setup wizard for missing core requirements', async ({ page }) => {
  await openDesktop(page, [
    requirement('windowsml-ocr', 'WindowsML OCR', 'installable'),
    requirement('ollama-runtime', '隔離 Ollama', 'missing'),
    requirement('capture-ollama-model', 'qwen3.5:0.8b 結構化模型', 'missing'),
  ]);

  await expect(page.getByRole('heading', { name: '文件擷取工作台' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '啟用本機文件處理' })).toBeVisible();
  await expect(page.getByRole('button', { name: '同意並安裝核心需求' })).toBeVisible();
  await expect(page.getByText('WindowsML OCR')).toBeVisible();
  await expect(page.getByText('隔離 Ollama', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '選擇檔案' })).toBeDisabled();
});

test('does not offer an install action when the runtime catalog marks OCR unavailable', async ({ page }) => {
  await openDesktop(page, [
    requirement('windowsml-ocr', 'WindowsML OCR', 'unavailable'),
  ]);

  await expect(page.locator('[data-testid="runtime-setup"]')).toBeVisible();
  await expect(page.locator('[data-testid="runtime-requirement"][data-requirement-id="windowsml-ocr"]')).toHaveAttribute('data-status', 'unavailable');
  await expect(page.locator('[data-testid="runtime-install"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="source-import"]')).toBeDisabled();
});

test('renders the Material desktop queue and history filter through the authenticated runtime client', async ({ page }) => {
  await openDesktop(page, []);

  await expect(page.getByText('Capture Runtime 已準備完成，可以開始處理文件。')).toBeVisible();
  await expect(page.getByText('history.pdf')).toBeVisible();
  await expect(page.getByText('Ollama · qwen3.5:0.8b')).toBeVisible();
  await expect(page.locator('.mat-mdc-form-field')).toHaveCount(2);
  await expect(page.locator('.mat-mdc-button-base').first()).toBeVisible();
  await page.getByLabel('搜尋文件').fill('history');

  const commands = await page.evaluate(() => {
    const target = globalThis as unknown as {
      readonly __captureInvokedCommands: readonly string[];
    };
    return target.__captureInvokedCommands;
  });
  expect(commands).toContain('desktop_runtime_status');
  expect(commands).toContain('runtime_requirements');
  expect(commands).not.toContain('backend_config');
  expect(commands.filter((command) => command === 'library_list').length).toBeGreaterThan(1);
});

test('does not run a deterministic provider in an unconfigured browser', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '文件擷取工作台' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Windows 桌面 App');
  await expect(page.getByText(/deterministic/i)).toHaveCount(0);
});

async function openDesktop(page: Page, requirements: readonly Record<string, unknown>[]): Promise<void> {
  await page.addInitScript((runtimeRequirements) => {
    interface TauriTestGlobal {
      isTauri: boolean;
      __captureInvokedCommands: string[];
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
    }
    const target = globalThis as unknown as TauriTestGlobal;
    target.isTauri = true;
    target.__captureInvokedCommands = [];
    target.__TAURI_INTERNALS__ = {
      invoke: (command: string): Promise<unknown> => {
        target.__captureInvokedCommands.push(command);
        if (command === 'desktop_runtime_status') {
          return Promise.resolve({ status: 'ready', detail: 'Capture Runtime 已準備完成。' });
        }
        if (command === 'runtime_requirements') {
          return Promise.resolve({ items: runtimeRequirements });
        }
        if (command === 'runtime_model_options') {
          return Promise.resolve({
            catalogSha256: 'a'.repeat(64),
            items: [{
              optionId: 'qwen3.5-0.8b-v1',
              displayName: 'Ollama · qwen3.5:0.8b',
              modelReference: 'qwen3.5:0.8b',
              expectedDigest: null,
              expectedBytes: null,
              profileId: 'capture-workbench-qwen3.5-0.8b-structure-v1',
              profileSpecSha256: 'b'.repeat(64),
              status: 'active',
            }],
          });
        }
        if (command === 'library_list') {
          return Promise.resolve([{
            documentId: 'a'.repeat(32), fileName: 'history.pdf', mediaType: 'application/pdf',
            byteLength: 2048, createdAtMs: 1, updatedAtMs: 1, status: 'completed', stage: 'completed',
          }]);
        }
        return Promise.reject(new Error(`Unexpected command: ${command}`));
      },
    };
  }, requirements);
  await page.goto('/');
}

function requirement(requirementId: string, displayName: string, status: string) {
  return {
    requirementId,
    displayName,
    status,
    kind: 'runtime',
    requiredFor: ['capture'],
    installStrategy: 'automatic',
    detail: '需要使用者同意後才能安裝。',
  };
}
