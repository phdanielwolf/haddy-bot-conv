import { Test, TestingModule } from '@nestjs/testing';
import { BotSynergysService } from './botsynergys.service';

describe('BotSynergysService', () => {
  let service: BotSynergysService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BotSynergysService],
    }).compile();

    service = module.get<BotSynergysService>(BotSynergysService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
