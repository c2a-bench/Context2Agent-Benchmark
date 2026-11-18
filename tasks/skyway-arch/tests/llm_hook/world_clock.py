"""The world's clock in the bot process: every clock the bot reads shows the stage's "now".

The grader passes BOT_CLOCK_OFFSET (seconds): the stage's world time (task.toml WORLD_NOW, e.g. the moment its
tickets were created) minus the real time when the ticket started. The bot's clock is the real clock shifted by that
fixed amount, so it starts at the world's now and runs on normally (timeouts and elapsed times stay right).

Shifted: time.time / time_ns, time.localtime / gmtime / ctime / asctime / strftime with no time given,
datetime.datetime.now / utcnow / today, datetime.date.today. Not shifted: time.monotonic and perf_counter (no
date), and TLS certificate checks (OpenSSL reads the system clock, so calls to the model provider keep working).

datetime.datetime and datetime.date cannot be patched in place (built-in types), so they are replaced by
subclasses that also count the real classes' instances as theirs (isinstance(real_datetime, datetime.datetime) is
still true), as freezegun does. The shell's `date` is covered by the `bin/date` stand-in the grader puts first on PATH.
"""

import copyreg
import datetime as _dt
import time as _time

real_time = _time.time
real_time_ns = _time.time_ns
_real_localtime = _time.localtime
_real_gmtime = _time.gmtime
_real_ctime = _time.ctime
_real_asctime = _time.asctime
_real_strftime = _time.strftime
RealDatetime = _dt.datetime
RealDate = _dt.date


def install(offset):
    """Shift the process's clocks by `offset` seconds."""

    def world_time():
        return real_time() + offset

    def world_time_ns():
        return real_time_ns() + int(offset * 1_000_000_000)

    _time.time = world_time
    _time.time_ns = world_time_ns
    _time.localtime = lambda secs=None: _real_localtime(world_time() if secs is None else secs)
    _time.gmtime = lambda secs=None: _real_gmtime(world_time() if secs is None else secs)
    _time.ctime = lambda secs=None: _real_ctime(world_time() if secs is None else secs)
    _time.asctime = lambda t=None: _real_asctime(_time.localtime() if t is None else t)
    _time.strftime = lambda fmt, t=None: _real_strftime(fmt, _time.localtime() if t is None else t)

    class _DateMeta(type):
        def __instancecheck__(cls, obj):
            return isinstance(obj, RealDate)

        def __subclasscheck__(cls, sub):
            return issubclass(sub, RealDate)

    class _DatetimeMeta(_DateMeta):
        def __instancecheck__(cls, obj):
            return isinstance(obj, RealDatetime)

        def __subclasscheck__(cls, sub):
            return issubclass(sub, RealDatetime)

    class date(RealDate, metaclass=_DateMeta):
        @classmethod
        def today(cls):
            t = RealDate.fromtimestamp(world_time())
            return cls(t.year, t.month, t.day)

    class datetime(RealDatetime, metaclass=_DatetimeMeta):
        # Built from world_time() itself: whether the real now()/today() read time.time (today() does) is not relied on.
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(world_time(), tz)

        @classmethod
        def utcnow(cls):
            return cls.fromtimestamp(world_time(), _dt.timezone.utc).replace(tzinfo=None)

        @classmethod
        def today(cls):
            return cls.fromtimestamp(world_time())

    for cls, real in ((date, RealDate), (datetime, RealDatetime)):
        cls.__name__, cls.__qualname__, cls.__module__ = real.__name__, real.__qualname__, "datetime"
    _dt.date = date
    _dt.datetime = datetime

    # pickle finds a class by its name: "datetime.datetime" is now the look-alike class, so a real datetime (from
    # arithmetic, parsing, a library) is pickled by its fields under that name. It loads back as a plain datetime
    # in any process, hooked or not.
    copyreg.pickle(RealDatetime, lambda d: (datetime, (d.year, d.month, d.day, d.hour, d.minute, d.second,
                                                       d.microsecond, d.tzinfo), {"fold": d.fold} if d.fold else None))
    copyreg.pickle(RealDate, lambda d: (date, (d.year, d.month, d.day)))
