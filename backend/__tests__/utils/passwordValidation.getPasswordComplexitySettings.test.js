const mockFirst = jest.fn();
const mockWhere = jest.fn(() => ({ first: mockFirst }));
const mockDb = jest.fn(() => ({ where: mockWhere }));
const mockWithRetry = jest.fn((operation) => operation());
const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../src/database/db', () => ({
  db: mockDb,
  withRetry: mockWithRetry,
}));

jest.mock('../../src/utils/logger', () => mockLogger);

const {
  getPasswordComplexitySettings,
} = require('../../src/utils/passwordValidation');

describe('getPasswordComplexitySettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['"simple"', 'simple'],
    ['"strong"', 'strong'],
    ['"very_strong"', 'very_strong'],
  ])('reads persisted value %s from the UI settings key', async (stored, expected) => {
    mockFirst.mockResolvedValueOnce({ setting_value: stored });

    await expect(getPasswordComplexitySettings()).resolves.toBe(expected);
    expect(mockDb).toHaveBeenCalledWith('app_settings');
    expect(mockWhere).toHaveBeenCalledWith(
      'setting_key',
      'security_password_complexity',
    );
  });

  it('returns moderate when the setting row does not exist', async () => {
    mockFirst.mockResolvedValueOnce(undefined);

    await expect(getPasswordComplexitySettings()).resolves.toBe('moderate');
  });

  it('returns moderate and logs when the database read fails', async () => {
    mockFirst.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(getPasswordComplexitySettings()).resolves.toBe('moderate');
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to get password complexity settings:',
      expect.any(Error),
    );
  });
});