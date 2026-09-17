import { BadRequestException } from '@nestjs/common';
import { ParseObjectIdPipe } from './parse-object-id.pipe';

describe('ParseObjectIdPipe', () => {
  let pipe: ParseObjectIdPipe;

  beforeEach(() => {
    pipe = new ParseObjectIdPipe();
  });

  it('accepts a valid 24-hex ObjectId and returns it unchanged', () => {
    const id = '112233445566778899001122';
    expect(pipe.transform(id)).toBe(id);
  });

  it('rejects an empty string with a 400-class error', () => {
    expect(() => pipe.transform('')).toThrow(BadRequestException);
  });

  it('rejects a non-hex identifier with a 400-class error', () => {
    expect(() => pipe.transform('not-an-id')).toThrow(BadRequestException);
  });

  it('rejects a correctly-shaped but non-hex 24-char string', () => {
    expect(() => pipe.transform('zzzzzzzzzzzzzzzzzzzzzzzz')).toThrow(
      BadRequestException,
    );
  });

  it('rejects an id containing traversal characters', () => {
    expect(() => pipe.transform('..%2F../etc/passwd')).toThrow(
      BadRequestException,
    );
  });
});
