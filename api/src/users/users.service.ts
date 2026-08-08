import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private userModel: Model<UserDocument>) {}

  async findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email }).select('+password').exec();
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  async create(data: {
    name: string;
    email: string;
    password: string;
  }): Promise<UserDocument> {
    return this.userModel.create(data);
  }

  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().exec();
  }
}
