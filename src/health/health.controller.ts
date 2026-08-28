import { Controller, Get } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';

@Controller('health')
export class HealthController {
  constructor(private readonly orm: MikroORM) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' | 'error'; database?: 'connected' }> {
    try {
      await this.orm.em.getConnection().execute('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch {
      return { status: 'error' };
    }
  }
}
