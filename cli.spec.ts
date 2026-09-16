import { parseArgs, runCli } from './cli';

describe('ngrx-migration-kit CLI', () => {
  it('resolves the source root relative to the invocation directory', () => {
    expect(
      parseArgs(['--root', 'src/app', '--path', 'store/animal/actions']),
    ).toMatchObject({
      rootDir: expect.stringMatching(/src[\\/]app$/),
      include: ['store/animal/actions'],
    });
  });

  it('accepts multiple include paths for staged migrations', () => {
    expect(
      parseArgs([
        '--path',
        'store/animal/actions',
        '--path',
        'store/order-kit',
        '--apply',
      ]),
    ).toMatchObject({
      include: ['store/animal/actions', 'store/order-kit'],
      apply: true,
    });
  });

  it.each(['--version', '-v'])('prints the package version for %s', (flag) => {
    const info = jest.spyOn(console, 'info').mockImplementation();

    expect(runCli([flag])).toBe(0);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+$/));

    info.mockRestore();
  });
});
