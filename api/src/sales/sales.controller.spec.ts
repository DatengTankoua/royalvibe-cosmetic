import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';

const VALID_OBJECT_ID = '112233445566778899001122';

/**
 * Reads the parameter pipes the SalesController declares on :id, exactly the
 * way Nest 11 stores them: `@Param` writes
 * `Reflect.defineMetadata('__routeArguments__', { [<key>]: { index, data,
 * pipes } }, target.constructor, methodName)`. The map key embeds a uid
 * generated per decorator, so we scan the map values instead of
 * reconstructing it.
 */
function readParamPipes(methodName: string): object[] {
  const args = (Reflect.getMetadata(
    '__routeArguments__',
    SalesController,
    methodName,
  ) ?? {}) as Record<string, { pipes?: object[] }>;
  return Object.values(args).flatMap((arg) => arg.pipes ?? []);
}

describe('SalesController :id validation (sec: M-1, phase 0B.1)', () => {
  describe('route metadata (real decorators)', () => {
    it('PATCH /sales/:id applies ParseObjectIdPipe to the id parameter', () => {
      expect(
        readParamPipes('update').some((p) => p === ParseObjectIdPipe),
      ).toBe(true);
    });

    it('DELETE /sales/:id applies ParseObjectIdPipe to the id parameter', () => {
      expect(
        readParamPipes('remove').some((p) => p === ParseObjectIdPipe),
      ).toBe(true);
    });
  });

  describe('pipe behaviour (the exact pipe the routes must use)', () => {
    const pipe = new ParseObjectIdPipe();

    it('accepts a valid ObjectId unchanged', () => {
      expect(pipe.transform(VALID_OBJECT_ID)).toBe(VALID_OBJECT_ID);
    });

    it.each([
      ['not-an-id', 'an arbitrary string'],
      ['', 'an empty string'],
      ['../../../etc/passwd', 'a traversal string'],
    ])('refuses %s with a BadRequestException', (_label, value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    });
  });
});
