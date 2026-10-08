import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { User, UserDocument, UserRole } from './schemas/user.schema';
import { recipientLocale, type AppLocale } from '../common/i18n/locale';

// Session transactionnelle Mongoose (`mongodb.ClientSession`) : même
// convention que `products.service.ts`/`audit.service.ts` (type dérivé,
// driver `mongodb` non résolvable directement depuis ce workspace pnpm).
type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<UserDocument>) {}

  async findByEmail(
    email: string,
    session?: MongooseSession,
  ): Promise<UserDocument | null> {
    // 1-13B : `authVersion` lu pour signer le JWT avec la version courante.
    return this.userModel
      .findOne({ email })
      .select('+password +authVersion')
      .session(session ?? null)
      .exec();
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  /** 1-13B : chargement pour l'authentification (version de session incluse). */
  async findByIdForAuth(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).select('+authVersion').exec();
  }

  async create(
    data: {
      name: string;
      email: string;
      password: string;
      role?: UserRole;
      locale?: AppLocale;
    },
    session?: MongooseSession,
  ): Promise<UserDocument> {
    const [user] = await this.userModel.create([data], { session });
    return user;
  }

  /** 1-16G : préférence de langue du compte, seul champ modifié. */
  async setLocale(userId: Types.ObjectId, locale: AppLocale): Promise<void> {
    await this.userModel
      .updateOne({ _id: userId }, { $set: { locale } })
      .exec();
  }

  /** 1-16G : langue des envois destinés à ce compte (repli français). */
  async localeOf(userId: Types.ObjectId | string): Promise<AppLocale> {
    const user = await this.userModel
      .findById(userId)
      .select('locale')
      .lean()
      .exec();
    return recipientLocale(user?.locale);
  }

  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().exec();
  }
}
