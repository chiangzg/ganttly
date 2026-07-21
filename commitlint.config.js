// Conventional Commits config — enforces the format `<type>(<scope>): <subject>`.
// Types follow Angular convention; scopes are free-form but lowercase.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat', // new feature
        'fix', // bug fix
        'docs', // documentation only
        'style', // formatting only (no code change)
        'refactor', // code change that neither fixes a bug nor adds a feature
        'perf', // performance improvement
        'test', // adding or correcting tests
        'build', // build system or external dependencies
        'ci', // CI configuration
        'chore', // misc repository tasks
        'revert', // revert a previous commit
      ],
    ],
    'subject-case': [0], // allow Chinese subjects
    'header-max-length': [2, 'always', 120],
  },
};
