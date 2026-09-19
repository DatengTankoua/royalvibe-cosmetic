import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthController, isPublicRegistrationEnabled } from './auth.controller';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

/**
 * AuthController — garde de l'inscription publique (0B.5).
 *
 * L'inscription est désactivée PAR DÉFAUT : seule la valeur EXACTE `true`
 * de `PUBLIC_REGISTRATION_ENABLED` l'active. En cas de refus, le contrôleur
 * lève `ForbiddenException` (403) avec le code stable `REGISTRATION_DISABLED`
 * SANS jamais appeler `AuthService.register`. `AuthService` est mocké pour
 * prouver l'absence d'appel et isoler la décision (pas de base, pas de
 * logique métier). Le garde lit `process.env` à CHAQUE requête.
 */
describe('AuthController — registre public (0B.5)', () => {
  let controller: AuthController;
  let registerMock: jest.Mock;
  let loginMock: jest.Mock;

  const VALID_REG: RegisterDto = {
    name: 'E2E User',
    email: 'e2e-register@royalvibe.test',
    password: 'secret-123',
  };
  const VALID_LOGIN: LoginDto = {
    email: 'seller@royalvibe.test',
    password: 'secret-123',
  };

  function callRegister(): unknown {
    try {
      return controller.register(VALID_REG);
    } catch (e) {
      return e;
    }
  }

  afterEach(() => {
    delete process.env.PUBLIC_REGISTRATION_ENABLED;
  });

  beforeEach(async () => {
    registerMock = jest.fn();
    loginMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: { register: registerMock, login: loginMock },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('isPublicRegistrationEnabled : vraie seulement pour la valeur exacte "true"', () => {
    expect(isPublicRegistrationEnabled()).toBe(false); // absente
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    expect(isPublicRegistrationEnabled()).toBe(true);
    process.env.PUBLIC_REGISTRATION_ENABLED = 'TRUE';
    expect(isPublicRegistrationEnabled()).toBe(false); // casse sensible
  });

  // Valeurs DÉSACTIVÉES : absente, false et valeurs invalides.
  it.each([
    ['absente', undefined],
    ['"false"', 'false'],
    ['"1"', '1'],
    ['"yes"', 'yes'],
    ['"TRUE" (sensible à la casse)', 'TRUE'],
    ['"true " (espace)', 'true '],
    ['"" (chaîne vide)', ''],
  ])(
    'désactivée (%s) → 403 REGISTRATION_DISABLED, service jamais appelé',
    (_label, value) => {
      if (value === undefined) {
        delete process.env.PUBLIC_REGISTRATION_ENABLED;
      } else {
        process.env.PUBLIC_REGISTRATION_ENABLED = value;
      }

      const error = callRegister();

      expect(error).toBeInstanceOf(ForbiddenException);
      const exc = error as ForbiddenException;
      expect(exc.getStatus()).toBe(403);
      expect((exc.getResponse() as { code: string }).code).toBe(
        'REGISTRATION_DISABLED',
      );
      expect(registerMock).not.toHaveBeenCalled();
    },
  );

  it('activée ("true") → comportement d’inscription existant (service appelé)', async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true';
    const result = { access_token: 'tok', user: { email: 'a@b.c' } };
    registerMock.mockResolvedValue(result);

    const out = await controller.register(VALID_REG);

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith(VALID_REG);
    expect(out).toEqual(result);
  });

  it('le login reste fonctionnel alors que l’inscription est désactivée', async () => {
    // Absente (désactivée) :
    delete process.env.PUBLIC_REGISTRATION_ENABLED;
    const token = { access_token: 'ok', user: { email: 's@b.c' } };
    loginMock.mockResolvedValue(token);

    const out = await controller.login(VALID_LOGIN);

    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual(token);

    // L’inscription reste fermée dans la même configuration :
    expect(callRegister()).toBeInstanceOf(ForbiddenException);
    expect(registerMock).not.toHaveBeenCalled();
  });
});
