const async = require('async');

const Task = require('../../models/task/Task');

const getLastSearchTime = require('./getLastSearchTime');
const setLastSearchTime = require('./setLastSearchTime');

const FIVE_MINUTES_IN_MS = 5 * 60 * 1000;
const INDEX_WAIT_TIME = 2 * 24 * 60 * 60 * 1000;

module.exports = callback => {
  getLastSearchTime('language_search', (err, last_looked_at) => {
    if (err) return callback(err);

    const count = parseInt(Math.max(0, Date.now() - (last_looked_at + INDEX_WAIT_TIME)) / FIVE_MINUTES_IN_MS);

    if (!count)
      return callback(null, 0);

    async.timesSeries(
      count,
      (time, next) => Task.createTask({
        type: 'language_search',
        data: {
          min_time: last_looked_at + time * FIVE_MINUTES_IN_MS,
          max_time: last_looked_at + (time + 1) * FIVE_MINUTES_IN_MS
        }
      }, err => {
        if (err && err != 'duplicated_unique_field')
          return next(err);
        return next(null);
      }),
      err => {
        if (err) return callback(err);

        setLastSearchTime('language_search', last_looked_at + count * FIVE_MINUTES_IN_MS, err => {
          if (err) return callback(err);

          callback(null, count);
        });
      }
    );
  });
};
