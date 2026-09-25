import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ObjectsService } from './objects.service';
import { S3Service } from '../s3/s3.service';
import { CreateObjectDto } from './dto/create-object.dto';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
// Dette 1-5B : module orphelin (jamais importé dans AppModule), sans org.
// Préfixe fixe uniquement pour rester compilable contre la signature S3.
const LEGACY_OBJECTS_PREFIX = 'legacy/objects';

@Controller('objects')
export class ObjectsController {
  constructor(
    private readonly objectsService: ObjectsService,
    private readonly s3Service: S3Service,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_IMAGE_SIZE_BYTES },
      fileFilter: (_req, file, callback) => {
        if (!file.mimetype.startsWith('image/')) {
          callback(
            new BadRequestException('Only image files are allowed'),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  async create(
    @Body() createObjectDto: CreateObjectDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Image file is required');
    }
    const imageUrl = await this.s3Service.uploadFile(
      file,
      LEGACY_OBJECTS_PREFIX,
    );
    return this.objectsService.create(createObjectDto, imageUrl);
  }

  @Get()
  findAll() {
    return this.objectsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseObjectIdPipe) id: string) {
    return this.objectsService.findOne(id);
  }

  @Delete(':id')
  remove(@Param('id', ParseObjectIdPipe) id: string) {
    return this.objectsService.remove(id);
  }
}
