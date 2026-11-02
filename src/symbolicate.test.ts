import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {formatFrames, injectionOf, parseStack, unshift} from './devserver/symbolicate.ts';

describe('js stacks', () => {
  it('reads Hermes source and bytecode frames and JSC frames, skipping native ones', () => {
    const stack = [
      'Error: boom',
      '    at onPress (http://localhost:8081/index.bundle?platform=android&dev=true:120:7)',
      '    at anonymous (address at http://localhost:8081/index.bundle?platform=android:1:9876)',
      '    at http://localhost:8081/index.bundle:5:6',
      '    at apply (native)',
      'render@http://localhost:8081/index.bundle:9:10',
    ].join('\n');
    expect(parseStack(stack)).toEqual([
      {methodName: 'onPress', file: 'http://localhost:8081/index.bundle?platform=android&dev=true', lineNumber: 120, column: 7},
      {methodName: 'anonymous', file: 'http://localhost:8081/index.bundle?platform=android', lineNumber: 1, column: 9876},
      {methodName: 'anonymous', file: 'http://localhost:8081/index.bundle', lineNumber: 5, column: 6},
      {methodName: 'render', file: 'http://localhost:8081/index.bundle', lineNumber: 9, column: 10},
    ]);
  });

  it('finds where the in-app script was spliced and undoes its lines', () => {
    const at = injectionOf('a\nb\n__r(1);\n__r(0);', ';X\nY;\n');
    expect(at).toEqual({line: 4, lines: 2});
    const f = (lineNumber: number) => ({methodName: 'f', file: 'u', lineNumber, column: 1});
    expect(unshift([f(3), f(4), f(5), f(6)], at).map(x => x.lineNumber)).toEqual([3, 4]);
  });

  it('prints app frames relative to the app root and leaves collapsed ones out', () => {
    const root = path.resolve('/app');
    const frames = [
      {methodName: 'onPress', file: path.join(root, 'src', 'a.ts'), lineNumber: 3, column: 4},
      {methodName: 'invoke', file: path.join(root, 'node_modules', 'react-native', 'x.js'), lineNumber: 1, column: 1, collapse: true},
    ];
    expect(formatFrames(frames, root)).toEqual(['onPress  src/a.ts:3:4']);
  });
});
