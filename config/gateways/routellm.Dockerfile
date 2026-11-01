FROM python:3.14-slim@sha256:cd89c30eda26ee911a4611b18680086e0ea42e6f5f8cbe653d07fa7958c9cec8
RUN pip install --no-cache-dir "routellm[serve]"
EXPOSE 6060
