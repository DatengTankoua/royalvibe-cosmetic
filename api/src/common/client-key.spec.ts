import { clientKeyFor } from './auth-rate-limiting';

describe('1-18C — clé client des essais après défi', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2001:DB8:0:0:ffff::1%eth0', '2001:db8:0:0::/64'],
    [undefined, 'unknown'],
  ])('%s → %s (même agrégation que le throttler)', (ip, expected) => {
    expect(clientKeyFor(ip)).toBe(expected);
  });
});
