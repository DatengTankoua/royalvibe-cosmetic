import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SectionDocument = HydratedDocument<Section>;

@Schema({ timestamps: true })
export class Section {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true, default: '' })
  description: string;
}

export const SectionSchema = SchemaFactory.createForClass(Section);
