import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decideVerdict,
  deviceScenarios,
  formatCleanupFailure,
  formatResultSummary,
  parseNvidiaSamples,
  parseWindowsSamples,
  preflightScenario,
  renderMarkdownReport,
  summarizeObservation,
  summarizeResults,
  type GpuAdapter,
  type ReportedCapture,
} from './real-engine-devices.ts';

const discrete = '000000000000d001';
const integrated = '000000000000a001';
const adapters: readonly GpuAdapter[] = [
  { luid: integrated, adapterClass: 'integrated', description: 'Integrated test GPU' },
  { luid: discrete, adapterClass: 'dedicated', description: 'Discrete test GPU' },
];
const speech = 'speech-recognition';
const speaker = 'speaker-diarization';
const ocr = 'text-recognition';
const scenario = (id: string) => {
  const found = deviceScenarios().find((item) => item.id === id);
  assert.ok(found, `no device scenario ${id}`);
  return found;
};
const speechScenario = scenario('speech-development');
const ocrScenario = scenario('ocr-default');
const speakerScenario = scenario('speaker-identification');
const cpuScenario = scenario('speech-cpu-pack');
const baseline = 'cpu,t0,10,5,1,True';
const poll = 'cpu,t1,11,5,2,True';
const finalPoll = 'cpu,t2,10,5,1,True';
const worker = (kind: string, identity = '40:100') => `worker,t1,${identity},${kind},1.25`;
const burst = (kind: string, luid = discrete, identity = '40:100') => `busy,t1,${identity},${luid},0,Compute,7000000,${kind}`;
const observe = (kind: string, ...rows: string[]) => summarizeObservation({
  ...parseWindowsSamples([baseline, ...rows, finalPoll].join('\n')), adapters, nvidia: [], worker: kind,
});
const speechCapture: ReportedCapture = {
  input: 'audio', status: 'awaiting_structuring', engine: speech, model: 'tea-asr-1.1-mini',
  device: 'cuda', fallbackWarnings: [], stages: [],
};
const ocrCapture: ReportedCapture = {
  input: 'pdf', status: 'awaiting_structuring', engine: ocr, device: 'directml', fallbackWarnings: [], stages: [],
};
const ocrCompute = { mode: 'gpu', adapterClass: 'dedicated' };

test('preflight requires discrete DirectML hardware and the NVIDIA driver only for CUDA speech packs', () => {
  assert.match(preflightScenario(ocrScenario, [adapters[0]], true) ?? '', /no discrete GPU/u);
  assert.match(preflightScenario(ocrScenario, [], true) ?? '', /no discrete GPU/u);
  assert.equal(preflightScenario(ocrScenario, adapters, false), undefined);
  assert.equal(preflightScenario(cpuScenario, [], false), undefined);
  for (const cudaScenario of [speechScenario, speakerScenario, scenario('speech-gpu-preference-off')]) {
    const unavailable = preflightScenario(cudaScenario, adapters, false);
    assert.ok(unavailable !== undefined);
    assert.match(unavailable, /nvcuda/u);
    assert.equal(decideVerdict({ scenario: cudaScenario, captures: [], observations: {}, unavailable }).verdict, 'not runnable');
    assert.equal(cudaScenario.environment['CAPTURE_SPEECH_RECOGNITION_VARIANT'], 'cuda');
    assert.equal(cudaScenario.environment['CAPTURE_SPEECH_RECOGNITION_ALLOW_CPU_FALLBACK'], 'false');
    assert.equal(preflightScenario(cudaScenario, adapters, true), undefined);
  }
  assert.equal(cpuScenario.environment['CAPTURE_SPEECH_RECOGNITION_VARIANT'], 'cpu');
});

test('sampler parses complete ticks, strips the BOM and skips malformed rows', () => {
  const parsed = parseWindowsSamples(`\uFEFF${baseline}\ncpu,t1,x,40,5,True\n${worker(speech)}\n${poll}\n${burst(speech)}`);
  assert.equal(parsed.cpu.length, 2);
  assert.equal(parsed.cpu[0].gpuOk, true);
  assert.equal(parsed.workers[0].worker, speech);
  assert.equal(parsed.busy[0].runningTime, 7_000_000);
  assert.deepEqual(parseNvidiaSamples('2026/01/01 00:00:00.000, 37, 2048\r\nbad line\n'), [
    { time: '2026/01/01 00:00:00.000', utilization: 37, memoryUsedMiB: 2048 },
  ]);
});

test('a single post-baseline worker burst survives worker exit', () => {
  const observed = observe(speech, worker(speech), burst(speech), poll);
  assert.equal(observed.observedDevice, 'dedicated-gpu');
  assert.equal(observed.ownedAdapterUse[0].busySeconds, 0.7);
  assert.equal(observed.ownedCpuSeconds, 1.25);
});

test('seven-field utilization rows classify the integrated GPU and expose dual-GPU activity', () => {
  const integratedRows = [
    `gpu,t1,owned,${integrated},Compute,20,${speech}`,
    `gpu,t2,owned,${integrated},Compute,25,${speech}`,
  ];
  assert.deepEqual(parseWindowsSamples(integratedRows[0]).gpu, [
    { time: 't1', owned: true, luid: integrated, engineType: 'Compute', utilization: 20, worker: speech },
  ]);
  const single = observe(speech, worker(speech), poll, ...integratedRows);
  assert.equal(single.observedDevice, 'integrated-gpu');
  assert.equal(single.ownedAdapterUse[0].activeSamples, 2);
  const dual = observe(speech, worker(speech), poll, ...integratedRows,
    `gpu,t1,owned,${discrete},Compute,30,${speech}`,
    `gpu,t2,owned,${discrete},Compute,35,${speech}`);
  assert.equal(dual.conflictingAdapters, true);
  assert.equal(dual.observedDevice, null);
});

test('NVIDIA summary reports peak utilization and memory increase from the first sample', () => {
  const nvidia = parseNvidiaSamples([
    '2026/01/01 00:00:00.000, 5, 1024',
    '2026/01/01 00:00:01.000, 37, 2048',
    '2026/01/01 00:00:02.000, 10, 1536',
  ].join('\n'));
  const observed = summarizeObservation({ ...parseWindowsSamples(baseline), adapters, nvidia });
  assert.equal(observed.nvidiaMaxUtilization, 37);
  assert.equal(observed.nvidiaMemoryRiseMiB, 1024);
});

test('existing worker cumulative time is subtracted; an uncompleted tick is ignored', () => {
  const observed = observe(speech, 'worker,t0,40:100,speech-recognition,1.25', worker(speech),
    burst(speech).replace(',t1,', ',t0,'), burst(speech), poll, burst(speech, integrated).replace(',t1,', ',incomplete,'));
  assert.equal(observed.ownedCpuSeconds, 0);
  assert.equal(observed.ownedAdapterUse[0].busySeconds, 0);
  assert.equal(observed.observedDevice, null);
});

test('CPU requires positive worker CPU time and complete, quiet GPU telemetry', () => {
  assert.equal(observe(speech, worker(speech), poll).observedDevice, 'cpu');
  assert.equal(observe(speech, worker(speaker), poll).observedDevice, null);
  assert.equal(observe(speech, worker(speech), poll.replace('True', 'False')).observedDevice, null);
  assert.equal(observe(speech, worker(speech), burst(speech).replace('7000000', '1'), poll).observedDevice, null);
  assert.equal(observe(speech, worker(speech), burst(speech).replace(/,compute,/iu, ',Copy,'), poll).observedDevice, null);
  assert.equal(observe(speech, worker(speech).replace('1.25', '0'), poll).observedDevice, null);
});

test('OCR needs independent PDF and image evidence and rejects simultaneous GPU activity', () => {
  const extraction = observe(ocr, worker(ocr), burst(ocr), poll);
  const both = observe(ocr, worker(ocr), burst(ocr), burst(ocr, integrated), poll);
  const input = { scenario: ocrScenario, captures: [ocrCapture, { ...ocrCapture, input: 'image' as const }], ocrCompute };
  assert.equal(decideVerdict({ ...input, observations: { pdf: { extraction }, image: { extraction } } }).verdict, 'pass');
  assert.equal(decideVerdict({ ...input, observations: { pdf: { extraction } } }).verdict, 'not observed');
  assert.equal(decideVerdict({ ...input, observations: { pdf: { extraction }, image: { extraction: both } } }).verdict, 'mismatch');
  assert.equal(decideVerdict({ ...input, ocrCompute: { mode: 'gpu', adapterClass: 'integrated' }, observations: { pdf: { extraction }, image: { extraction } } }).verdict, 'mismatch');
});

test('speaker identification requires its own CPU evidence, not speech GPU activity', () => {
  const extraction = observe(speech, worker(speech), burst(speech), poll);
  const speakerCpu = observe(speaker, worker(speech), burst(speech), worker(speaker, '41:100'), poll);
  const speakerGpu = observe(speaker, worker(speaker), burst(speaker), poll);
  const input = { scenario: speakerScenario, captures: [{ ...speechCapture, diarizationDevice: 'cpu' }], installedPack: 'cuda' };
  assert.equal(decideVerdict({ ...input, observations: { audio: { extraction, speaker: speakerCpu } } }).verdict, 'pass');
  assert.equal(decideVerdict({ ...input, observations: { audio: { extraction } } }).verdict, 'not observed');
  assert.equal(decideVerdict({ ...input, observations: { audio: { extraction, speaker: speakerGpu } } }).verdict, 'mismatch');
});

test('verified installed pack and matching provenance are required', () => {
  const extraction = observe(speech, worker(speech), burst(speech), poll);
  const input = { scenario: speechScenario, captures: [speechCapture], observations: { audio: { extraction } } };
  assert.equal(decideVerdict({ ...input, installedPack: 'cuda' }).verdict, 'pass');
  assert.equal(decideVerdict(input).verdict, 'not observed');
  assert.equal(decideVerdict({ ...input, installedPack: 'cuda', captures: [{ ...speechCapture, device: null }] }).verdict, 'not observed');
  assert.equal(decideVerdict({ ...input, installedPack: 'cpu' }).verdict, 'mismatch');
  assert.equal(decideVerdict({ ...input, installedPack: 'cuda', captures: [{ ...speechCapture, device: 'cpu', fallbackWarnings: ['GPU fallback'] }] }).verdict, 'mismatch');
  assert.equal(decideVerdict({ ...input, captures: [{ ...speechCapture, status: 'failed' }] }).verdict, 'failed');
  assert.equal(decideVerdict({ scenario: cpuScenario, captures: [{ ...speechCapture, device: 'cpu' }],
    observations: { audio: { extraction: observe(speech, worker(speech), poll) } }, installedPack: 'cpu' }).verdict, 'pass');
});

test('observe mode does not report an empty process tree as CPU use', () => {
  const observation = summarizeObservation({ ...parseWindowsSamples('cpu,t0,0,10,0,True\ncpu,t1,0,20,0,True'), adapters, nvidia: [] });
  assert.equal(observation.matchingProcessObserved, false);
  assert.equal(observation.observedDevice, null);
  const markdown = renderMarkdownReport({ title: 'Device check', preamble: [], pending: ['speech-cpu-pack'], results: [{
    scenario: speechScenario.id, summary: speechScenario.summary, expectation: speechScenario.expectation,
    environment: speechScenario.environment, ocrCompute: null, captures: [speechCapture], observations: { audio: { extraction: observation } },
    verdict: 'not observed', reasons: [], evidenceDirectory: 'evidence/speech-development',
  }] });
  assert.match(markdown, /not observed \(no matching process\)/u);
  assert.match(markdown, /speech-cpu-pack \| \| \| \| not run yet/u);
});

test('exit decision returns 0 for pass and not runnable alone, and 1 for any failure verdict', () => {
  const allPass = summarizeResults([
    { scenario: 'ocr-default', verdict: 'pass' },
    { scenario: 'speech-cpu-pack', verdict: 'pass' },
  ]);
  assert.deepEqual(allPass, { pass: 2, fail: 0, notRunnable: 0, notRunnableScenarios: [], exitCode: 0 });
  assert.equal(formatResultSummary(allPass), 'Summary: 2 pass, 0 fail, 0 not runnable');

  const withNotRunnable = summarizeResults([
    { scenario: 'ocr-default', verdict: 'pass' },
    { scenario: 'speech-development', verdict: 'not runnable' },
    { scenario: 'speaker-identification', verdict: 'not runnable' },
  ]);
  assert.deepEqual(withNotRunnable, {
    pass: 1,
    fail: 0,
    notRunnable: 2,
    notRunnableScenarios: ['speech-development', 'speaker-identification'],
    exitCode: 0,
  });
  assert.equal(
    formatResultSummary(withNotRunnable),
    'Summary: 1 pass, 0 fail, 2 not runnable (speech-development, speaker-identification)',
  );

  for (const failingVerdict of ['failed', 'mismatch', 'not observed'] as const) {
    const summary = summarizeResults([
      { scenario: 'ocr-default', verdict: 'pass' },
      { scenario: 'speech-development', verdict: 'not runnable' },
      { scenario: 'speech-cpu-pack', verdict: failingVerdict },
    ]);
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.pass, 1);
    assert.equal(summary.fail, 1);
    assert.equal(summary.notRunnable, 1);
    assert.deepEqual(summary.notRunnableScenarios, ['speech-development']);
  }

  assert.equal(summarizeResults([]).exitCode, 0);
});

test('cleanup failure report names process image, pid and wait duration', () => {
  const message = formatCleanupFailure({
    processes: [{ pid: 4321, name: 'python' }],
    listeners: [],
    waitMs: 35_000,
  });
  assert.equal(
    message,
    'Owned Capture Runtime cleanup left 1 process(es) (python (pid 4321)) and 0 listener(s) after 35 s wait.',
  );

  const withListener = formatCleanupFailure({
    processes: [],
    listeners: [{ pid: 9999, port: 18421 }],
    waitMs: 10_000,
  });
  assert.equal(
    withListener,
    'Owned Capture Runtime cleanup left 0 process(es) and 1 listener(s) (pid 9999 port 18421) after 10 s wait.',
  );
});
