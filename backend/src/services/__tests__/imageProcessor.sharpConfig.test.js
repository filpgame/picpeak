const mockSharp = jest.fn();
mockSharp.cache = jest.fn();
mockSharp.concurrency = jest.fn();

jest.mock('sharp', () => mockSharp);

jest.mock('../../utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

describe('imageProcessor Sharp configuration', () => {
  it('disables the Sharp cache and caps libvips concurrency', () => {
    jest.isolateModules(() => {
      require('../imageProcessor');
    });

    expect(mockSharp.cache).toHaveBeenCalledWith(false);
    expect(mockSharp.concurrency).toHaveBeenCalledWith(2);
  });
});
