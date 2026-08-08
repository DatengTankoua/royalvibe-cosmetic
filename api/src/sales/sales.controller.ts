import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/schemas/user.schema';

@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Post()
  create(@Body() dto: CreateSaleDto, @CurrentUser() user: User) {
    return this.salesService.create(dto, user._id.toString());
  }

  @Get()
  findAll(@Query('productId') productId?: string) {
    return this.salesService.findAll(productId);
  }
}
