const mockFirst = jest.fn();
const mockChain = {
  where: jest.fn(() => mockChain),
  select: jest.fn(() => mockChain),
  first: mockFirst,
};
const mockDb = jest.fn(() => mockChain);

jest.mock('../../src/database/db', () => ({ db: mockDb }));

const {
  getRecipientLanguage,
} = require('../../src/services/emailProcessor');

describe('getRecipientLanguage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFirst.mockReset();
  });

  it('uses general_default_language when the event language is null', async () => {
    mockFirst
      .mockResolvedValueOnce({ language: null })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ setting_value: '"de"' });

    await expect(getRecipientLanguage('guest@example.com', 42)).resolves.toBe('de');
  });

  it('preserves an explicit event language override', async () => {
    mockFirst.mockResolvedValueOnce({ language: 'fr' });

    await expect(getRecipientLanguage('guest@example.com', 42)).resolves.toBe('fr');
    expect(mockFirst).toHaveBeenCalledTimes(1);
  });
});