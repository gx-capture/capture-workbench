import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideVerdict,
  designedOcrAdapter,
  deviceScenarios,
  parseNvidiaSamples,
  parseWindowsSamples,
  renderMarkdownReport,
  summarizeObservation,
  type GpuAdapter,
  type ReportedCapture,
} from './real-engine-devices.ts';

const discrete = '000000000000d001';
const integrated = '000000000000a001';
const adapters: readonly GpuAdapter[] = [
  { luid: integrated, adapterClass: 'integrated', description: 'Integrated test GPU' },
  { luid: discrete, adapterClass: 'dedicated', description: 'Discrete test GPU' },
  { luid: '000000000000f001', adapterClass: 'software', description: 'Software renderer' },
];

function windowsSamples(rows: readonly (readonly [string, string, string, number])[], ticks: number): string {
  const lines = ['\uFEFFcpu,2026-01-01T00:00:00.000Z,1.5,10,3'];
  for (let tick = 1; tick <= ticks; tick += 1) {
    const time = `2026-01-01T00:00:0${tick}.000Z`;
    for (const [scope, luid, engine, value] of rows) lines.push(`gpu,${time},${scope},${luid},${engine},${value}`);
    lines.push(`cpu,${time},${1.5 + tick * 2},${20 + tick},4`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

test('the designed OCR adapter is the discrete GPU, then the integrated one', () => {
  assert.equal(designedOcrAdapter(adapters), 'dedicated');
  assert.equal(designedOcrAdapter(adapters.filter((item) => item.adapterClass !== 'dedicated')), 'integrated');
  assert.equal(designedOcrAdapter(adapters.filter((item) => item.adapterClass === 'software')), undefined);
  const ocr = deviceScenarios([adapters[2]]).find((scenario) => scenario.id === 'ocr-default');
  assert.equal(ocr?.expectation.device, 'cpu');
  assert.equal(ocr?.expectation.observed, 'cpu');
});

test('scenario ids are unique and every speech scenario refuses a CPU fallback', () => {
  const scenarios = deviceScenarios(adapters);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
  for (const scenario of scenarios.filter((item) => item.expectation.engine === 'speech-recognition')) {
    assert.equal(scenario.environment['CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK'], 'false', scenario.id);
  }
  assert.equal(scenarios.find((item) => item.id === 'speech-cpu-pack')?.appData, 'cpu-pack');
});

test('sampler lines parse, skipping malformed rows and the byte order mark', () => {
  const parsed = parseWindowsSamples([
    '\uFEFFgpu,t1,owned,000000000000d001,Compute,12.5',
    'gpu,t1,owned,not-a-luid,Compute,12.5',
    'gpu,t1,mine,000000000000d001,3D,1',
    'cpu,t1,3.25,40,5',
    'cpu,t1,x,40,5',
    '',
  ].join('\n'));
  assert.deepEqual(parsed.gpu, [{ time: 't1', owned: true, luid: discrete, engineType: 'Compute', utilization: 12.5 }]);
  assert.deepEqual(parsed.cpu, [{ time: 't1', ownedCpuSeconds: 3.25, totalPercent: 40, ownedProcesses: 5 }]);
  assert.deepEqual(parseNvidiaSamples('2026/01/01 00:00:00.000, 37, 2048\r\nbad line\n'), [
    { time: '2026/01/01 00:00:00.000', utilization: 37, memoryUsedMiB: 2048 },
  ]);
});

test('owned compute work on the discrete adapter is observed as the discrete GPU', () => {
  const windows = parseWindowsSamples(windowsSamples([
    ['owned', discrete, 'Compute', 40],
    ['owned', integrated, 'Copy', 90],
    ['other', integrated, '3D', 80],
  ], 4));
  const observation = summarizeObservation({ ...windows, nvidia: parseNvidiaSamples('t, 0, 600\nt, 55, 2600\n'), adapters });
  assert.equal(observation.observedDevice, 'dedicated-gpu');
  assert.equal(observation.ownedAdapterUse[0]?.luid, discrete);
  assert.equal(observation.ownedAdapterUse[0]?.activeSamples, 4);
  assert.equal(observation.ownedCpuSeconds, 8);
  assert.equal(observation.nvidiaMaxUtilization, 55);
  assert.equal(observation.nvidiaMemoryRiseMiB, 2000);
});

test('copy traffic, other processes and brief touches are observed as the CPU', () => {
  const windows = parseWindowsSamples(windowsSamples([
    ['owned', discrete, 'Copy', 60],
    ['other', discrete, 'Compute', 99],
  ], 5));
  assert.equal(summarizeObservation({ ...windows, nvidia: [], adapters }).observedDevice, 'cpu');
  const brief = parseWindowsSamples(`${windowsSamples([], 3)}gpu,2026-01-01T00:00:09.000Z,owned,${discrete},Compute,70\n`);
  assert.equal(summarizeObservation({ ...brief, nvidia: [], adapters }).observedDevice, 'cpu');
  const integratedWork = parseWindowsSamples(windowsSamples([['owned', integrated, 'Compute', 30]], 3));
  assert.equal(summarizeObservation({ ...integratedWork, nvidia: [], adapters }).observedDevice, 'integrated-gpu');
  assert.equal(summarizeObservation({ gpu: [], cpu: [], nvidia: [], adapters }).observedDevice, null);
});

test('busy time counts a GPU burst that no utilization sample caught', () => {
  const text = [
    windowsSamples([], 3),
    // The worker existed from the first sample; its earlier busy time is not counted.
    `busy,2026-01-01T00:00:01.000Z,40,${discrete},0,Compute,90000000`,
    `busy,2026-01-01T00:00:03.000Z,40,${discrete},0,Compute,120000000`,
    // A process started during the span counts from zero.
    `busy,2026-01-01T00:00:02.000Z,41,${discrete},1,Compute,4000000`,
    // Copy engines and short probes do not make an adapter used.
    `busy,2026-01-01T00:00:01.000Z,40,${integrated},0,Copy,1`,
    `busy,2026-01-01T00:00:03.000Z,40,${integrated},0,Copy,90000000`,
    `busy,2026-01-01T00:00:02.000Z,42,${integrated},0,3D,1000000`,
  ].join('\n');
  const parsed = parseWindowsSamples(text);
  assert.equal(parsed.busy.length, 6);
  const observation = summarizeObservation({ ...parsed, nvidia: [], adapters });
  assert.equal(observation.observedDevice, 'dedicated-gpu');
  assert.equal(observation.ownedAdapterUse[0]?.busySeconds, 3.4);
  assert.equal(observation.ownedAdapterUse.find((use) => use.luid === integrated)?.busySeconds, 0.1);
});

const speechScenario = deviceScenarios(adapters).find((scenario) => scenario.id === 'speech-development')!;
const ocrScenario = deviceScenarios(adapters).find((scenario) => scenario.id === 'ocr-default')!;
const gpuObservation = summarizeObservation({
  ...parseWindowsSamples(windowsSamples([['owned', discrete, 'Compute', 50]], 4)),
  nvidia: [],
  adapters,
});
const speechCapture: ReportedCapture = {
  input: 'audio',
  status: 'awaiting_structuring',
  engine: 'speech-recognition',
  model: 'tea-asr-1.1-mini',
  device: 'cuda',
  diarizationDevice: null,
  fallbackWarnings: [],
  stages: [],
};

test('a capture on the designed device, seen on that device, passes', () => {
  assert.deepEqual(
    decideVerdict({ expectation: speechScenario.expectation, captures: [speechCapture], observation: gpuObservation }),
    { verdict: 'pass', reasons: [] },
  );
});

test('a wrong reported device, a fallback notice or a wrong observed device is a mismatch', () => {
  const cpuCapture = { ...speechCapture, device: 'cpu', fallbackWarnings: ['Speech recognition GPU fallback: OutOfMemoryError'] };
  const decided = decideVerdict({ expectation: speechScenario.expectation, captures: [cpuCapture], observation: gpuObservation });
  assert.equal(decided.verdict, 'mismatch');
  assert.equal(decided.reasons.length, 2);
  const cpuObservation = { ...gpuObservation, observedDevice: 'cpu' as const };
  assert.deepEqual(
    decideVerdict({ expectation: speechScenario.expectation, captures: [speechCapture], observation: cpuObservation }).reasons,
    ['observed cpu, designed dedicated-gpu'],
  );
});

test('OCR also checks the readiness selection, and failed captures fail the scenario', () => {
  const ocrCapture: ReportedCapture = {
    input: 'pdf', status: 'awaiting_structuring', engine: 'text-recognition', model: 'pp-ocrv6-medium',
    device: 'directml', fallbackWarnings: [], stages: [],
  };
  assert.equal(decideVerdict({
    expectation: ocrScenario.expectation,
    captures: [ocrCapture],
    ocrCompute: { mode: 'gpu', adapterClass: 'dedicated' },
    observation: gpuObservation,
  }).verdict, 'pass');
  assert.deepEqual(decideVerdict({
    expectation: ocrScenario.expectation,
    captures: [ocrCapture],
    ocrCompute: { mode: 'gpu', adapterClass: 'integrated' },
    observation: gpuObservation,
  }).reasons, ['OCR readiness adapter integrated, designed dedicated']);
  assert.deepEqual(decideVerdict({
    expectation: speechScenario.expectation,
    captures: [{ input: 'audio', status: 'failed', fallbackWarnings: [], stages: [], errorCode: 'session_failed', errorStage: 'speech-model-load-cuda-failed' }],
    observation: gpuObservation,
  }), { verdict: 'failed', reasons: ['audio capture ended as failed (session_failed at speech-model-load-cuda-failed)'] });
  assert.equal(decideVerdict({
    expectation: speechScenario.expectation,
    captures: [speechCapture],
    observation: { ...gpuObservation, observedDevice: null },
  }).verdict, 'inconclusive');
});

test('the report lists finished and pending scenarios', () => {
  const markdown = renderMarkdownReport({
    title: 'Device check',
    preamble: ['Synthetic run.'],
    results: [{
      scenario: speechScenario.id,
      summary: speechScenario.summary,
      expectation: speechScenario.expectation,
      environment: speechScenario.environment,
      ocrCompute: null,
      captures: [speechCapture],
      observation: gpuObservation,
      verdict: 'pass',
      reasons: [],
      evidenceDirectory: 'evidence/speech-development',
    }],
    pending: ['speech-cpu-pack'],
  });
  assert.match(markdown, /\| speech-development \| cuda \(tea-asr-1\.1-mini\)/u);
  assert.match(markdown, /\| speech-cpu-pack \| \| \| \| not run yet \|/u);
});
