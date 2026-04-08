import { Test, TestingModule } from '@nestjs/testing';
import { LocalAIService } from './localai.service';

describe('LocalaiService', () => {
  let service: LocalAIService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LocalAIService],
    }).compile();

    service = module.get<LocalAIService>(LocalAIService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
