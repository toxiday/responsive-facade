"""Offline bake for the Responsive Facade web demo.

Importing the package applies the workspace environment rules before anything heavy loads.
"""

from . import config

config.apply_env()
