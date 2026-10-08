import {
  Controller,
  Get,
  GoneException,
  Post,
  Delete,
  Param,
} from '@nestjs/common';
import { ObjectsService } from './objects.service';
import { ParseObjectIdPipe } from '../common/pipes/parse-object-id.pipe';

// Dette 1-5B : module orphelin (jamais importé dans AppModule), sans org.

@Controller('objects')
export class ObjectsController {
  constructor(private readonly objectsService: ObjectsService) {}

  /**
   * Stockage R2 privé : ce module orphelin (jamais importé dans AppModule)
   * n'envoie plus aucun fichier — il fabriquait une URL publique, sans
   * organisation. Toute création est refusée (410).
   */
  @Post()
  create() {
    throw new GoneException({
      code: 'LEGACY_OBJECTS_DISABLED',
      message: 'Cette fonctionnalité a été retirée.',
    });
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
