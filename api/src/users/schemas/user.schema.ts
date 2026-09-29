import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { USER_NAME_MAX_LENGTH } from '../../common/validation/name-rules';

export type UserDocument = HydratedDocument<User>;

export enum UserRole {
  ADMIN = 'admin',
  SELLER = 'seller',
}

@Schema({ timestamps: true })
export class User {
  _id: Types.ObjectId;

  /**
   * 1-12C : 1 à 80 caractères après trim (défense en profondeur ; le DTO
   * reste la première barrière). Aucune migration : un document historique
   * plus long reste lisible tel quel.
   */
  @Prop({
    required: true,
    trim: true,
    minlength: 1,
    maxlength: USER_NAME_MAX_LENGTH,
  })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, select: false })
  password: string;

  @Prop({ enum: UserRole, default: UserRole.SELLER })
  role: UserRole;
}

export const UserSchema = SchemaFactory.createForClass(User);
