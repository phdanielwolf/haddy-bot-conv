import { Test, TestingModule } from '@nestjs/testing';
import { VenomService } from './venom.service';

describe('VenomService', () => {
  let service: VenomService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VenomService],
    }).compile();

    service = module.get<VenomService>(VenomService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
