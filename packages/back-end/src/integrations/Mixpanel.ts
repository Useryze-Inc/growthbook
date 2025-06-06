import cloneDeep from "lodash/cloneDeep";
import {
  getConversionWindowHours,
  getDelayWindowHours,
} from "shared/experiments";
import { ReqContext } from "back-end/types/organization";
import {
  DataSourceInterface,
  DataSourceProperties,
} from "back-end/types/datasource";
import { DimensionInterface } from "back-end/types/dimension";
import { MixpanelConnectionParams } from "back-end/types/integrations/mixpanel";
import { MetricInterface, MetricType } from "back-end/types/metric";
import { decryptDataSourceParams } from "back-end/src/services/datasource";
import { formatQuery, runQuery } from "back-end/src/services/mixpanel";
import {
  DimensionSlicesQueryResponse,
  DropTableQueryResponse,
  ExperimentAggregateUnitsQueryResponse,
  ExperimentMetricQueryResponse,
  ExperimentQueryResponses,
  ExperimentUnitsQueryResponse,
  MetricAnalysisQueryResponse,
  MetricValueParams,
  MetricValueQueryResponse,
  MetricValueQueryResponseRow,
  MetricValueQueryResponseRows,
  PastExperimentQueryResponse,
  SourceIntegrationInterface,
} from "back-end/src/types/Integration";
import {
  conditionToJavascript,
  getAggregateFunctions,
  getMixpanelPropertyColumn,
} from "back-end/src/util/mixpanel";
import { compileSqlTemplate } from "back-end/src/util/sql";
import { ExperimentSnapshotSettings } from "back-end/types/experiment-snapshot";
import { applyMetricOverrides } from "back-end/src/util/integration";

export default class Mixpanel implements SourceIntegrationInterface {
  context: ReqContext;
  datasource: DataSourceInterface;
  params: MixpanelConnectionParams;
  decryptionError: boolean;
  constructor(context: ReqContext, datasource: DataSourceInterface) {
    this.context = context;
    this.datasource = datasource;

    // Default settings
    this.datasource.settings.events = {
      experimentEvent: "$experiment_started",
      experimentIdProperty: "Experiment name",
      variationIdProperty: "Variant name",
      ...this.datasource.settings.events,
    };

    this.decryptionError = false;
    try {
      this.params = decryptDataSourceParams<MixpanelConnectionParams>(
        datasource.params
      );
    } catch (e) {
      this.params = { projectId: "", secret: "", username: "" };
      this.decryptionError = true;
    }
  }
  getMetricAnalysisQuery(): string {
    throw new Error("Method not implemented.");
  }
  runMetricAnalysisQuery(): Promise<MetricAnalysisQueryResponse> {
    throw new Error("Method not implemented.");
  }
  getDropUnitsTableQuery(): string {
    throw new Error("Method not implemented.");
  }
  runDropTableQuery(): Promise<DropTableQueryResponse> {
    throw new Error("Method not implemented.");
  }
  getExperimentMetricQuery(): string {
    throw new Error("Method not implemented.");
  }
  getExperimentAggregateUnitsQuery(): string {
    throw new Error("Method not implemented.");
  }
  runExperimentAggregateUnitsQuery(): Promise<ExperimentAggregateUnitsQueryResponse> {
    throw new Error("Method not implemented.");
  }
  runExperimentMetricQuery(): Promise<ExperimentMetricQueryResponse> {
    throw new Error("Method not implemented.");
  }
  getExperimentUnitsTableQuery(): string {
    throw new Error("Method not implemented.");
  }
  runExperimentUnitsQuery(): Promise<ExperimentUnitsQueryResponse> {
    throw new Error("Method not implemented.");
  }
  private getMetricAggregationExpression(metric: MetricInterface) {
    if (metric.aggregation) {
      return `${metric.aggregation}`;
    }
    if (metric.type === "count" && !metric.column) {
      return "values.length";
    }
    return `sum(values)`;
  }
  private aggregateMetricValues(metric: MetricInterface, destVar: string) {
    if (metric.type === "binomial") {
      return `// Metric - ${metric.name}
      ${destVar} = ${destVar}.length ? 1 : 0;`;
    }

    return `// Metric - ${metric.name}
    ${destVar} = !${destVar}.length ? 0 : (
      (values => ${this.getMetricAggregationExpression(metric)})(${destVar})
    );${
      metric.cappingSettings.type === "absolute" && metric.cappingSettings.value
        ? `\n${destVar} = ${destVar} && Math.min(${destVar}, ${metric.cappingSettings.value});`
        : ""
    }
    `;
  }

  getExperimentResultsQuery(
    snapshotSettings: ExperimentSnapshotSettings,
    metricDocs: MetricInterface[],
    activationMetricDoc: MetricInterface,
    dimension: DimensionInterface
  ): string {
    const activationMetric = cloneDeep<MetricInterface>(activationMetricDoc);
    applyMetricOverrides(activationMetric, snapshotSettings);

    const metrics = metricDocs.map((m) => {
      const mCopy = cloneDeep<MetricInterface>(m);
      applyMetricOverrides(mCopy, snapshotSettings);
      return mCopy;
    });

    const hasEarlyStartMetrics =
      metrics.filter((m) => getDelayWindowHours(m.windowSettings) < 0).length >
      0;

    const onActivate = `
        ${activationMetric ? "state.activated = true;" : ""}
        state.start = event.time;
        ${
          hasEarlyStartMetrics
            ? ` // Process queued values
        state.queuedEvents.forEach((event) => {
          ${metrics
            .filter((m) => getDelayWindowHours(m.windowSettings) < 0)
            .map(
              (metric, i) => `// Metric - ${metric.name}
          if(isMetric${i}(event) && event.time - state.start > ${
                getDelayWindowHours(metric.windowSettings) * 60 * 60 * 1000
              }) {
            state.m${i}.push(${this.getMetricValueExpression(metric.column)});
          }`
            )
            .join("\n")}
        });
        state.queuedEvents = [];`
            : ""
        }`;

    const query = formatQuery(`${this.getMathHelperFunctions()}
        // Experiment exposure event
        function isExposureEvent(event) {
          return ${this.getValidExperimentCondition(
            snapshotSettings.experimentId,
            snapshotSettings.startDate,
            snapshotSettings.endDate
          )};
        }
        ${
          activationMetric
            ? this.getMetricFunction(activationMetric, "ActivationMetric")
            : ""
        }
        ${metrics
          .map((m, i) => this.getMetricFunction(m, `Metric${i}`))
          .join("")}

        return ${this.getEvents(
          snapshotSettings.startDate,
          snapshotSettings.endDate,
          [
            ...metrics.map((m) => m.table),
            activationMetric?.table,
            this.getExperimentEventName(),
          ]
        )}
        .filter(function(event) {
          // Experiment exposure event
          if(isExposureEvent(event)) return true;
          ${
            activationMetric
              ? `// ${activationMetric.name}
              if(isActivationMetric(event)) return true;`
              : ""
          }
          ${metrics
            .map(
              (metric, i) => `// ${metric.name}
          if(isMetric${i}(event)) return true;`
            )
            .join("\n")}
          // Otherwise, ignore the event
          return false;
        })
        // Array of metric values for each user
        .groupByUser(${this.getGroupByUserFields()}function(state, events) {
          state = state || {
            inExperiment: false,
            multipleVariants: false,
            ${dimension ? "dimension: null," : ""}
            ${activationMetric ? "activated: false," : ""}
            start: null,
            variation: null,
            ${metrics.map((m, i) => `m${i}: [],`).join("\n")} ${
      hasEarlyStartMetrics ? "\nqueuedEvents: []" : ""
    }
          };
          for(var i=0; i<events.length; i++) {
            const event = events[i];
            // User is put into the experiment
            if(isExposureEvent(event)) {
              if(!state.inExperiment) {
                state.inExperiment = true;
                state.variation = ${getMixpanelPropertyColumn(
                  this.datasource.settings.events?.variationIdProperty ||
                    "Variant name"
                )};
                ${
                  dimension
                    ? `state.dimension = (${this.getDimensionColumn(
                        dimension.sql,
                        snapshotSettings.startDate,
                        snapshotSettings.endDate,
                        snapshotSettings.experimentId
                      )}) || null;`
                    : ""
                }
                ${activationMetric ? "" : onActivate}
                continue;
              }
              else if(state.variation !== ${getMixpanelPropertyColumn(
                this.datasource.settings.events?.variationIdProperty ||
                  "Variant name"
              )}) {
                state.multipleVariants = true;
                continue;
              }
              else {
                continue;
              }
            }

            // Not in the experiment yet
            if(!state.inExperiment) {
              ${hasEarlyStartMetrics ? "state.queuedEvents.push(event);" : ""}
              continue;
            }
            // Saw multiple variants so ignore
            if(state.multipleVariants) {
              continue;
            }
            ${
              activationMetric
                ? `
              // Not activated yet
              if(!state.activated) {
                // Does this event activate it? (Metric - ${
                  activationMetric.name
                })
                if(isActivationMetric(event)) {
                  ${onActivate}
                }
                else {
                  ${
                    hasEarlyStartMetrics
                      ? "state.queuedEvents.push(event);"
                      : ""
                  }
                  continue;
                }
              }
            `
                : ""
            }

            ${metrics
              .map((metric, i) => {
                const conversionWindowCondition = this.getConversionWindowCondition(
                  metric,
                  snapshotSettings.endDate,
                  "state.start"
                );

                return `// Metric - ${metric.name}
                    if(isMetric${i}(event) ${
                  conversionWindowCondition
                    ? `&& ${conversionWindowCondition}`
                    : ""
                }) {
                      state.m${i}.push(${this.getMetricValueExpression(
                  metric.column
                )});
                    }
                  `;
              })
              .join("")}
          }
          return state;
        })
        // Remove users that are not in the experiment
        .filter(function(ev) {
          if(!ev.value.inExperiment) return false;
          if(ev.value.multipleVariants) return false;
          if(ev.value.variation === null || ev.value.variation === undefined) return false;
          ${activationMetric ? "if(!ev.value.activated) return false;" : ""}
          return true;
        })
        // Aggregate the metric value arrays for each user
        .map(function(user) {
          ${metrics
            .map((metric, i) =>
              this.aggregateMetricValues(metric, `user.value.m${i}`)
            )
            .join("\n")}

          return user;
        })
        // One group per experiment variation${
          dimension ? "/dimension" : ""
        } with summary data
        .groupBy(["value.variation"${dimension ? ', "value.dimension"' : ""}], [
          // Total users in the group
          mixpanel.reducer.count(),
          ${metrics
            .map(
              (metric, i) => `// Metric - ${metric.name}
          mixpanel.reducer.numeric_summary('value.m${i}'),`
            )
            .join("\n")}
        ])
        // Convert to an object that's easier to work with
        .map(row => {
          const ret = {
            variation: row.key[0],
            dimension: ${dimension ? "row.key[1] || ''" : "''"},
            users: row.value[0],
            metrics: [],
          };
          const metricIds = [
            ${metrics
              .map(
                (m) => `
              // ${m.name}
              ${JSON.stringify(m.id)}`
              )
              .join(",")}
          ];
          const metricTypes = [
            ${metrics.map((m) => `${JSON.stringify(m.type)}`).join(",")}
          ];
          for(let i=1; i<row.value.length; i++) {
            ret.metrics.push({
              id: metricIds[i-1],
              metric_type: metricTypes[i-1],
              count: row.value[i].count,
              main_sum: row.value[i].sum,
              main_sum_squares: row.value[i].sum_squares,
            });
          }
          return ret;
        });
      `);

    return query;
  }
  async getExperimentResults(
    snapshotSettings: ExperimentSnapshotSettings,
    metrics: MetricInterface[],
    activationMetric: MetricInterface,
    dimension: DimensionInterface
  ): Promise<ExperimentQueryResponses> {
    const query = this.getExperimentResultsQuery(
      snapshotSettings,
      metrics,
      activationMetric,
      dimension
    );

    const result = await runQuery<
      {
        variation: string;
        dimension: string;
        users: number;
        metrics: {
          id: string;
          metric_type: MetricType;
          count: number;
          main_sum: number | null;
          main_sum_squares: number | null;
        }[];
      }[]
    >(this.params, query);

    return result.map(({ variation, dimension, users, metrics }) => {
      return {
        dimension,
        variation,
        users,
        metrics: metrics.map((m) => {
          return {
            metric: m.id,
            users,
            metric_type: m.metric_type,
            count: m.count,
            main_sum: m.main_sum || 0,
            main_sum_squares: m.main_sum_squares || 0,
          };
        }),
      };
    });
  }
  async testConnection(): Promise<boolean> {
    const today = new Date().toISOString().substr(0, 10);
    const query = formatQuery(`
      return Events({
        from_date: "${today}",
        to_date: "${today}"
      })
      .reduce(mixpanel.reducer.count());
    `);
    await runQuery(this.params, query);
    return true;
  }
  getSourceProperties(): DataSourceProperties {
    return {
      queryLanguage: "javascript",
      metricCaps: true,
      segments: true,
      dimensions: true,
      hasSettings: true,
      events: true,
    };
  }

  getMetricValueQuery(params: MetricValueParams): string {
    const metric = params.metric;

    return formatQuery(`
      ${this.getMathHelperFunctions()}
      ${this.getMetricFunction(metric, "Metric")}

      // ${params.name} - Metric value (${metric.name})
      return ${this.getEvents(params.from, params.to, [metric.table])}
        .filter(function(event) {
          ${
            params.segment
              ? `// Limit to Segment - ${params.segment.name}
          if(!(${params.segment.sql})) return false;`
              : ""
          }
          if(isMetric(event)) return true;
          return false;
        })
        // Metric value per user
        .groupByUser(${this.getGroupByUserFields()}function(state, events) {
          state = state || {date: null, metricValue: []};
          for(var i=0; i<events.length; i++) {
            state.date = state.date || events[i].time;
            const event = events[i];
            if(isMetric(event)) {
              state.metricValue.push(${this.getMetricValueExpression(
                metric.column
              )});
            }
          }
          return state;
        })
        // Remove users that did not convert
        .filter(function(ev) {
          return ev.value.date && ev.value.metricValue.length > 0;
        })
        // Aggregate metric values per user
        .map(function(user) {
          ${this.aggregateMetricValues(metric, "user.value.metricValue")}
          return user;
        })
        .reduce([
          // Overall summary metrics
          mixpanel.reducer.numeric_summary('value.metricValue')${
            params.includeByDate
              ? `,
            // Summary metrics by date
            (prevs, events) => {
              const dates = {};
              prevs.forEach(prev => {
                prev.dates.forEach(d=>{
                  dates[d.date] = dates[d.date] || {count:0, sum:0, sum_squares:0};
                  dates[d.date].count += d.count;
                  dates[d.date].sum += d.sum;
                  dates[d.date].sum_squares += d.sum_squares;
                })
              });
              events.forEach(e=>{
                const date = (new Date(e.value.date)).toISOString().substr(0,10);
                dates[date] = dates[date] || {count:0, sum:0, sum_squares:0};
                dates[date].count++;
                dates[date].sum += e.value.metricValue;
                dates[date].sum_squares += Math.pow(e.value.metricValue, 2);
              });

              return {
                type: "byDate",
                dates: Object.keys(dates).map(d => ({
                  date: d,
                  ...dates[d]
                }))
              };
            }`
              : ""
          }
        ])
        // Transform into easy-to-use objects
        .map(vals => vals.map(val => {
          if(val.count) return {type: "overall", ...val};
          return val;
        }));
        `);
  }
  async runMetricValueQuery(query: string): Promise<MetricValueQueryResponse> {
    const rows = await runQuery<
      [
        (
          | {
              type: "byDate";
              dates: {
                date: string;
                count: number;
                sum: number | null;
                sum_squares: number | null;
              }[];
            }
          | {
              type: "overall";
              count: number;
              sum: number | null;
              sum_squares: number | null;
            }
        )[]
      ]
    >(this.params, query);

    const result: MetricValueQueryResponseRows = [];
    const overall: MetricValueQueryResponseRow = {
      date: "",
      count: 0,
      main_sum: 0,
      main_sum_squares: 0,
    };

    rows &&
      rows[0] &&
      rows[0].forEach((row) => {
        if (row.type === "overall") {
          overall.count = row.count;
          overall.main_sum = row.sum || 0;
          overall.main_sum_squares = row.sum_squares || 0;
        } else if (row.type === "byDate") {
          row.dates.sort((a, b) => a.date.localeCompare(b.date));
          row.dates.forEach(({ date, count, sum, sum_squares }) => {
            result.push({
              date,
              count,
              main_sum: sum || 0,
              main_sum_squares: sum_squares || 0,
            });
          });
        }
      });

    return { rows: [overall, ...result] };
  }
  getPastExperimentQuery(): string {
    throw new Error("Method not implemented.");
  }
  async runPastExperimentQuery(): Promise<PastExperimentQueryResponse> {
    throw new Error("Method not implemented.");
  }
  getDimensionSlicesQuery(): string {
    throw new Error("Method not implemented.");
  }
  async runDimensionSlicesQuery(): Promise<DimensionSlicesQueryResponse> {
    throw new Error("Method not implemented.");
  }
  getSensitiveParamKeys(): string[] {
    return ["secret"];
  }

  private getMetricFunction(metric: MetricInterface, name: string) {
    return `
// ${metric.name}
function is${name}(event) {
  return ${this.getValidMetricCondition(metric)};
}
    `;
  }

  private getMetricValueExpression(col?: string) {
    if (!col) return "1";

    // Use the column directly if it contains a reference to `event`
    if (col.match(/\bevent\b/)) {
      return col;
    }
    // Use the column directly if it's a number
    if (col.match(/^[0-9][0-9.]*/)) {
      return col;
    }

    return getMixpanelPropertyColumn(col);
  }

  private getEventNames(event?: string) {
    if (!event) return [];
    return event
      .split(/ OR /g)
      .map((e) => e.trim())
      .filter(Boolean);
  }

  private getGroupByUserFields() {
    if (this.datasource.settings?.events?.extraUserIdProperty) {
      return (
        JSON.stringify([
          this.datasource.settings?.events?.extraUserIdProperty,
        ]) + ","
      );
    }
    return "";
  }

  private getEvents(from: Date, to: Date, events: (string | undefined)[]) {
    const uniqueEvents = new Set<string>();
    events.forEach((event) => {
      const eventNames = this.getEventNames(event);
      eventNames.forEach((name) => uniqueEvents.add(name));
    });

    const filter = {
      from_date: from.toISOString().substr(0, 10),
      to_date: to.toISOString().substr(0, 10),
      event_selectors: Array.from(uniqueEvents).map((e) => {
        return {
          event: e,
        };
      }),
    };

    return `Events(${JSON.stringify(filter, null, 2)})`;
  }
  private getDimensionColumn(
    col: string,
    startDate: Date,
    endDate?: Date,
    experimentId?: string
  ) {
    return compileSqlTemplate(getMixpanelPropertyColumn(col), {
      startDate,
      endDate,
      experimentId,
    });
  }

  private getConversionWindowCondition(
    metric: MetricInterface,
    experimentEnd: Date,
    conversionWindowStart: string = ""
  ) {
    const windowHours = getConversionWindowHours(metric.windowSettings);
    const checks: string[] = [];
    const start = getDelayWindowHours(metric.windowSettings) * 60 * 60 * 1000;
    // add conversion delay
    if (start) {
      checks.push(`event.time - ${conversionWindowStart} >= ${start}`);
    }
    // if conversion window, add conversion end
    if (metric.windowSettings.type === "conversion") {
      const end = start + windowHours * 60 * 60 * 1000;
      checks.push(`event.time - ${conversionWindowStart} < ${end}`);
    }
    // if lookback window, add additional lookback start
    if (metric.windowSettings.type === "lookback") {
      const lookbackLength = windowHours * 60 * 60 * 1000;
      checks.push(
        `${experimentEnd.getTime()} - event.time <= ${lookbackLength}`
      );
    }
    return checks.length ? checks.join(" && ") : "";
  }

  private getValidMetricCondition(metric: MetricInterface) {
    const checks: string[] = [];
    // Right event name
    const eventNames = this.getEventNames(metric.table);
    if (eventNames.length === 1) {
      checks.push(`event.name === ${JSON.stringify(eventNames[0])}`);
    } else {
      checks.push(`${JSON.stringify(eventNames)}.includes(event.name)`);
    }

    if (metric.conditions) {
      metric.conditions.forEach((condition) => {
        checks.push(conditionToJavascript(condition));
      });
    }

    return checks.join(" && ");
  }
  private getExperimentEventName() {
    return (
      this.datasource.settings.events?.experimentEvent || "$experiment_started"
    );
  }
  private getValidExperimentCondition(id: string, start: Date, end?: Date) {
    const experimentEvent = this.getExperimentEventName();
    const experimentIdCol = getMixpanelPropertyColumn(
      this.datasource.settings.events?.experimentIdProperty || "Experiment name"
    );
    let timeCheck = `event.time >= ${start.getTime()}`;
    if (end) {
      timeCheck += ` && event.time <= ${end.getTime()}`;
    }
    return `event.name === "${experimentEvent}" && ${experimentIdCol} === "${id}" && ${timeCheck}`;
  }

  private getMathHelperFunctions() {
    return `
// Helper aggregation functions
${getAggregateFunctions()}

    `;
  }
}
