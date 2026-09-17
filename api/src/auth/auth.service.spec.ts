import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

const USER_OBJECT_ID = '112233445566778899001122';

/**
 * Nest 11 `HttpException.getResponse()` returns an object
 * ({ statusCode, error, message }) for string-bodied exceptions, while
 * older versions returned the raw string. This helper normalizes both
 * shapes so the assertions stay stable across Nest versions.
 */
function extractMessage(error: unknown): string {
  const body = (error as { getResponse?: () => unknown }).getResponse
    ? (error as { getResponse: () => unknown }).getResponse()
    : error;
  if (typeof body === 'string') return body;
  if (body !== null && typeof body === 'object' && 'message' in body) {
    return String(body['message']);
  }
  return String(body);
}

function makeUserDoc(overrides: Record<string, unknown> = {}): unknown {
  const doc = {
    _id: USER_OBJECT_ID,
    name: 'Ada',
    email: 'ada@example.com',
    password: '$2a$10$x7VQm9LbRdHhGk2sP0v1OeuJ5tYzWAbCdEfGhIjKlMnOpQrStUvWx',
    role: 'seller',
    ...overrides,
  };
  return {
    ...doc,
    toObject: () => ({ ...doc }),
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let usersService: { findByEmail: jest.Mock; create: jest.Mock };
  let jwt: { sign: jest.Mock };

  beforeEach(async () => {
    usersService = { findByEmail: jest.fn(), create: jest.fn() };
    jwt = { sign: jest.fn().mockReturnValue('signed-token') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('register', () => {
    it('rejects registration when the email is already taken', async () => {
      usersService.findByEmail.mockResolvedValue(makeUserDoc());
      usersService.create.mockRejectedValue(
        new Error('create must not be called when the email exists'),
      );

      await expect(
        service.register({
          name: 'Ada',
          email: 'ada@example.com',
          password: 'secret1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(usersService.create).not.toHaveBeenCalled();
    });

    it('returns a JWT and a user object that never contains the password', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(makeUserDoc());

      const { access_token, user } = await service.register({
        name: 'Ada',
        email: 'ada@example.com',
        password: 'secret1',
      });

      expect(access_token).toBe('signed-token');
      // The stored bcrypt hash must never leak into the response.
      expect(user.password).toBeUndefined();
      expect('password' in user).toBe(false);
      expect(user.email).toBe('ada@example.com');
    });

    it('documents the current role behaviour: registration never assigns a role in code — the schema default "seller" applies', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(makeUserDoc());

      await service.register({
        name: 'Ada',
        email: 'ada@example.com',
        password: 'secret1',
      });

      // AuthService.register does not set a role: it relies on the
      // Mongoose schema default (UserRole.SELLER) — the user returned by
      // the (mocked) UsersService.create is what jwt.sign sees. This pins
      // the current behaviour. The README claim "first user is admin" is
      // NOT implemented in code (audit §1 / C-3).
      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: USER_OBJECT_ID, role: 'seller' }),
      );
    });

    it('stores a bcrypt hash, not the plain-text password', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      usersService.create.mockResolvedValue(makeUserDoc());

      await service.register({
        name: 'Ada',
        email: 'ada@example.com',
        password: 'secret1',
      });

      const created = usersService.create.mock.calls[0][0] as {
        password: string;
      };
      expect(created.password).not.toBe('secret1');
      await expect(bcrypt.compare('secret1', created.password)).resolves.toBe(
        true,
      );
    });
  });

  describe('login', () => {
    it('rejects login for an unknown email with a generic message', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      const error: unknown = await service
        .login({ email: 'missing@example.com', password: 'secret1' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(extractMessage(error)).toBe('Email ou mot de passe incorrect!');
    });

    it('rejects login for a wrong password with the same generic message', async () => {
      const hash = await bcrypt.hash('right-password-1', 10);
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: hash }),
      );

      const error: unknown = await service
        .login({ email: 'ada@example.com', password: 'wrong-password-1' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnauthorizedException);
      // No difference between "unknown email" and "wrong password":
      // the message does not reveal which one failed.
      expect(extractMessage(error)).toBe('Email ou mot de passe incorrect!');
    });

    it('returns a JWT and a sanitized user on successful login', async () => {
      const hash = await bcrypt.hash('right-password-1', 10);
      usersService.findByEmail.mockResolvedValue(
        makeUserDoc({ password: hash }),
      );

      const { access_token, user } = await service.login({
        email: 'ada@example.com',
        password: 'right-password-1',
      });

      expect(access_token).toBe('signed-token');
      expect(user.password).toBeUndefined();
      expect('password' in user).toBe(false);
    });
  });
});
