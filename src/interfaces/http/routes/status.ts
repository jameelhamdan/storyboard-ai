import type { AppInstance } from '../AppInstance.js';
import '@fastify/swagger';
import type { Container } from '../../composition/container.js';
import { presentStatus } from '../dto/presenter.js';
import { sendError } from '../errorMapper.js';
import { statusResponseSchema, errorResponseSchema } from '../dto/schemas.js';
import { jsonSchema } from '../dto/openapi.js';

export async function registerStatusRoutes(app: AppInstance, container: Container): Promise<void> {
  app.get<{ Params: { job_id: string } }>('/v1/status/:job_id', {
    schema: {
      summary: 'Poll a generation job',
      description: 'Returns 200 in every non-terminal state; 404 if the job is unknown or its state has expired.',
      tags: ['generation'],
      // Deliberately no `format: uuid` here: an id that cannot exist must 404
      // like any other unknown id, not 400. JobId does the validating.
      params: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
      response: {
        200: jsonSchema(statusResponseSchema, 'Current job state; artifacts and cost once completed.'),
        404: jsonSchema(errorResponseSchema, 'Unknown job, or its state has expired.'),
        503: jsonSchema(errorResponseSchema, 'Job store unreachable — retryable.'),
      },
    },
  }, async (request, reply) => {
    try {
      const job = await container.getStatus.execute(request.params.job_id);
      if (!job) {
        return await reply.status(404).send({
          error: { code: 'NOT_FOUND', message: `No job with id '${request.params.job_id}'.` },
        });
      }
      return await reply.status(200).send(presentStatus(job));
    } catch (error) {
      return await sendError(reply, error);
    }
  });

  app.delete<{ Params: { job_id: string } }>('/v1/jobs/:job_id', {
    schema: {
      summary: 'Cancel a queued or processing job',
      description: 'A running job stops at its next stage boundary; cancellation is cooperative.',
      tags: ['generation'],
      // Deliberately no `format: uuid` here: an id that cannot exist must 404
      // like any other unknown id, not 400. JobId does the validating.
      params: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
      response: {
        202: jsonSchema(statusResponseSchema, 'The job, now cancelled.'),
        404: jsonSchema(errorResponseSchema, 'Unknown job.'),
        409: jsonSchema(errorResponseSchema, 'Job is already terminal.'),
      },
    },
  }, async (request, reply) => {
    try {
      const result = await container.cancelJob.execute(request.params.job_id);

      switch (result.kind) {
        case 'not_found':
          return await reply.status(404).send({
            error: { code: 'NOT_FOUND', message: `No job with id '${request.params.job_id}'.` },
          });
        case 'already_terminal':
          return await reply.status(409).send({
            error: {
              code: 'CONFLICT',
              message: `Job is already '${result.job.status}' and cannot be cancelled.`,
              details: { status: result.job.status },
            },
          });
        case 'cancelled':
          return await reply.status(202).send(presentStatus(result.job));
      }
    } catch (error) {
      return await sendError(reply, error);
    }
  });
}
