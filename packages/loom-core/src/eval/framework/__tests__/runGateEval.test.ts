import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import { runGateEval } from '../runGateEval.js';
import type {
  GateEvalCase,
  GateOutcome,
  JudgeOutcome,
  GateDeps,
  JudgeDeps,
} from '../types.js';

// ── Stub case ─────────────────────────────────────────────────────────────────

interface StubCase extends GateEvalCase {
  payload: string;
}

interface StubOutput {
  result: string;
}

interface StubJudgment {
  pass: boolean;
}

function makeCase(id: string, payload = 'data'): StubCase {
  return { id, source: 'test', payload };
}

function makeDeps(llm: MockLLMClient): GateDeps & JudgeDeps {
  return { llm, gateModel: 'gate-model', judgeModel: 'judge-model' };
}

// ── Gate call count — AC1 ─────────────────────────────────────────────────────

describe('runGateEval — exactly ≤1 gate call + ≤1 judge call per case', () => {
  it('issues exactly 1 gate call and 1 judge call for 1 case (gate ok)', async () => {
    const llm = new MockLLMClient([]);
    let gateCalls = 0;
    let judgeCalls = 0;

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        gateCalls++;
        return { status: 'ok', output: { result: 'ok' } };
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        judgeCalls++;
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    const records = await runGateEval([makeCase('c1')], consumer, makeDeps(llm));

    assert.equal(gateCalls, 1, 'exactly 1 gate call for 1 case');
    assert.equal(judgeCalls, 1, 'exactly 1 judge call for 1 case when gate ok');
    assert.equal(records.length, 1);
  });

  it('issues exactly N gate calls and N judge calls for N cases (all gate ok)', async () => {
    const llm = new MockLLMClient([]);
    const N = 5;
    let gateCalls = 0;
    let judgeCalls = 0;

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        gateCalls++;
        return { status: 'ok', output: { result: 'ok' } };
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        judgeCalls++;
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    const cases = Array.from({ length: N }, (_, i) => makeCase(`c${i}`));
    const records = await runGateEval(cases, consumer, makeDeps(llm));

    assert.equal(gateCalls, N, `exactly ${N} gate calls for ${N} cases`);
    assert.equal(judgeCalls, N, `exactly ${N} judge calls for ${N} cases when all gate ok`);
    assert.equal(records.length, N);
  });
});

// ── Gate ok → judge called with output ───────────────────────────────────────

describe('runGateEval — gate ok → judge is called with gate output', () => {
  it('judge receives the gate output when gate returns ok', async () => {
    const llm = new MockLLMClient([]);
    const gateOutput: StubOutput = { result: 'specific-output' };
    let capturedOutput: StubOutput | undefined;

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        return { status: 'ok', output: gateOutput };
      },
      async judge(_c: StubCase, output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        capturedOutput = output;
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    await runGateEval([makeCase('c1')], consumer, makeDeps(llm));

    assert.deepEqual(capturedOutput, gateOutput, 'judge receives the exact gate output');
  });

  it('RunRecord carries gate and judge results for an ok gate', async () => {
    const llm = new MockLLMClient([]);

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        return { status: 'ok', output: { result: 'value' } };
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    const [record] = await runGateEval([makeCase('my-id')], consumer, makeDeps(llm));

    assert.equal(record.caseId, 'my-id');
    assert.equal(record.gate.status, 'ok');
    assert.equal(record.judge.status, 'ok');
  });
});

// ── Gate failed → judge NOT called, RunRecord carries skipped ─────────────────

describe('runGateEval — gate failed → judge NOT called', () => {
  it('judge is NOT called when gate returns failed', async () => {
    const llm = new MockLLMClient([]);
    let judgeCalls = 0;

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        return { status: 'failed', detail: 'gate rejected' };
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        judgeCalls++;
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    const [record] = await runGateEval([makeCase('c1')], consumer, makeDeps(llm));

    assert.equal(judgeCalls, 0, 'judge must NOT be called when gate fails');
    assert.equal(record.judge.status, 'skipped', 'RunRecord must carry judge.status=skipped');
    assert.equal(record.gate.status, 'failed');
  });

  it('judge is NOT called for any of N gate-failed cases', async () => {
    const llm = new MockLLMClient([]);
    let judgeCalls = 0;

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        return { status: 'failed', detail: 'always fail' };
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        judgeCalls++;
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    const cases = Array.from({ length: 3 }, (_, i) => makeCase(`c${i}`));
    const records = await runGateEval(cases, consumer, makeDeps(llm));

    assert.equal(judgeCalls, 0, 'judge must NOT be called for any gate-failed case');
    assert.ok(records.every((r) => r.judge.status === 'skipped'), 'all RunRecords must carry judge.status=skipped');
  });
});

// ── Gate throw → failed ───────────────────────────────────────────────────────

describe('runGateEval — gate that throws maps to {status: failed}', () => {
  it('thrown error from runGate maps to gate={status:failed}', async () => {
    const llm = new MockLLMClient([]);

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        throw new Error('network timeout');
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    const [record] = await runGateEval([makeCase('c1')], consumer, makeDeps(llm));

    assert.equal(record.gate.status, 'failed', 'thrown exception → gate.status=failed');
    if (record.gate.status === 'failed') {
      assert.ok(record.gate.detail.includes('network timeout'), 'error message preserved in detail');
    }
    assert.equal(record.judge.status, 'skipped', 'judge must not be called after gate throw');
  });

  it('gate throw is isolated per case — other cases still run', async () => {
    const llm = new MockLLMClient([]);
    let callIndex = 0;

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        const i = callIndex++;
        if (i === 0) throw new Error('first case fails');
        return { status: 'ok', output: { result: 'ok' } };
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    const records = await runGateEval([makeCase('c0'), makeCase('c1')], consumer, makeDeps(llm));

    assert.equal(records.length, 2, 'both cases produce a record');
    assert.equal(records[0].gate.status, 'failed', 'first case gate failed');
    assert.equal(records[0].judge.status, 'skipped', 'first case judge skipped');
    assert.equal(records[1].gate.status, 'ok', 'second case gate ok');
    assert.equal(records[1].judge.status, 'ok', 'second case judge ok');
  });
});

// ── Judge throw/parse-fail → inconclusive (never a fake pass) ────────────────

describe('runGateEval — judge that throws maps to {status: inconclusive}', () => {
  it('thrown error from judge maps to judge={status:inconclusive}', async () => {
    const llm = new MockLLMClient([]);

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        return { status: 'ok', output: { result: 'ok' } };
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        throw new Error('parse failed');
      },
    };

    const [record] = await runGateEval([makeCase('c1')], consumer, makeDeps(llm));

    assert.equal(record.gate.status, 'ok', 'gate was ok');
    assert.equal(record.judge.status, 'inconclusive', 'judge throw → inconclusive, never a fake pass');
    if (record.judge.status === 'inconclusive') {
      assert.ok(record.judge.detail.includes('parse failed'), 'error message preserved in detail');
    }
  });

  it('judge throw is isolated per case — other cases still produce ok judge', async () => {
    const llm = new MockLLMClient([]);
    let judgeCallIndex = 0;

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        return { status: 'ok', output: { result: 'ok' } };
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        if (judgeCallIndex++ === 0) throw new Error('judge error on first');
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    const records = await runGateEval([makeCase('c0'), makeCase('c1')], consumer, makeDeps(llm));

    assert.equal(records[0].judge.status, 'inconclusive', 'first judge threw → inconclusive');
    assert.equal(records[1].judge.status, 'ok', 'second judge succeeded → ok');
  });
});

// ── Mixed gate outcomes ───────────────────────────────────────────────────────

describe('runGateEval — mixed gate outcomes across cases', () => {
  it('gate call count is always totalCases; judge call count is only gate-ok cases', async () => {
    const llm = new MockLLMClient([]);
    let gateCalls = 0;
    let judgeCalls = 0;
    let gateIndex = 0;

    const consumer = {
      async runGate(_c: StubCase, _deps: GateDeps): Promise<GateOutcome<StubOutput>> {
        gateCalls++;
        return gateIndex++ % 2 === 0
          ? { status: 'ok', output: { result: 'ok' } }
          : { status: 'failed', detail: 'fail' };
      },
      async judge(_c: StubCase, _output: StubOutput, _deps: JudgeDeps): Promise<JudgeOutcome<StubJudgment>> {
        judgeCalls++;
        return { status: 'ok', judgment: { pass: true } };
      },
    };

    // 4 cases: 0=ok, 1=fail, 2=ok, 3=fail → 2 gate-ok cases
    const cases = Array.from({ length: 4 }, (_, i) => makeCase(`c${i}`));
    await runGateEval(cases, consumer, makeDeps(llm));

    assert.equal(gateCalls, 4, 'gate called once per case regardless of outcome');
    assert.equal(judgeCalls, 2, 'judge called only for gate-ok cases');
  });
});
