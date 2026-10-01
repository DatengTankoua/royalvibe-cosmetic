import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Connection } from 'mongoose';
import { User, UserDocument, UserRole } from './schemas/user.schema';

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
    },
    session?: MongooseSession,
  ): Promise<UserDocument> {
    const [user] = await this.userModel.create([data], { session });
    return user;
  }

  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().exec();
  }
}
