const componentUtils = require('../components/componentUtils');
const createError = require('http-errors');

const getApplicationDef = (appName) => {
  const appDefs = componentUtils.getApplicationDefs();
  return appDefs.find((appDef) => appDef.metadata.name === appName);
};

const createAccessSecret = async (appDef, namespace, stringData, coreV1Api) => {
  const { enable } = appDef.spec;
  if (!enable) {
    return Promise.resolve();
  }

  stringData.configMapName = enable.validationConfigMap;
  const name = enable.validationSecret;
  const secret = {
    apiVersion: 'v1',
    metadata: { name, namespace },
    type: 'Opaque',
    stringData,
  };
  return coreV1Api
    .readNamespacedSecret(name, namespace)
    .then(() => {
      return coreV1Api.replaceNamespacedSecret(name, namespace, secret);
    })
    .catch(() => {
      return coreV1Api.createNamespacedSecret(namespace, secret);
    });
};

const createValidationJob = async ({ fastify, request }) => {
  const namespace = fastify.kube.namespace;
  const appName = request.query?.appName;
  const stringData = JSON.parse(request.query?.values ?? {});
  const batchV1beta1Api = fastify.kube.batchV1beta1Api;
  const batchV1Api = fastify.kube.batchV1Api;
  const coreV1Api = fastify.kube.coreV1Api;
  const appDef = getApplicationDef(appName);
  const { enable } = appDef.spec;

  const cronjobName = enable?.validationJob;
  if (!cronjobName) {
    const error = createError(500, 'failed to validate');
    error.explicitInternalServerError = true;
    error.error = 'failed to find application definition file';
    error.message = 'Unable to validate the application.';
    throw error;
  }

  return createAccessSecret(appDef, namespace, stringData, coreV1Api).then(() => {
    return batchV1beta1Api.readNamespacedCronJob(cronjobName, namespace).then(async (res) => {
      const cronJob = res.body;
      const jobSpec = cronJob.spec.jobTemplate.spec;
      const jobName = `${cronjobName}-job-custom-run`;
      const job = {
        apiVersion: 'batch/v1',
        metadata: {
          name: jobName,
          namespace,
          annotations: {
            'cronjob.kubernetes.io/instantiate': 'manual',
          },
        },
        spec: jobSpec,
      };
      // Flag the cronjob as no longer suspended
      cronJob.spec.suspend = false;
      await batchV1beta1Api.replaceNamespacedCronJob(cronjobName, namespace, cronJob).catch((e) => {
        fastify.log.error(`failed to unsuspend cronjob: ${e.response.body.message}`);
      });

      // If there was a manual job already, delete it
      await batchV1Api.deleteNamespacedJob(jobName, namespace).catch(() => {});

      // Some delay to allow job to delete
      return new Promise((resolve) => setTimeout(resolve, 1000)).then(() =>
        batchV1Api.createNamespacedJob(namespace, job),
      );
    });
  });
};

module.exports = { createAccessSecret, createValidationJob };
