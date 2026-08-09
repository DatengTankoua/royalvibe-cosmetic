import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SectionDocument = HydratedDocument<Section>;

@Schema({ timestamps: true })
export class Section {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ trim: true, default: '' })
  description: string;

  @Prop({ type: Date, default: null })
  deletedAt: Date | null;
}

export const SectionSchema = SchemaFactory.createForClass(Section);
