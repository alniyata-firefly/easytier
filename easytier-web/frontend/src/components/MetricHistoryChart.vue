<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ObservabilityDisplay } from 'easytier-frontend-lib';

interface ChartSeries { name: string; values: ObservabilityDisplay.HistoryPoint[] }
const props = defineProps<{ title: string; unit: string; start: number; end: number; step: number; series: ChartSeries[] }>();
const { t } = useI18n();
const colors = ['#3b82f6', '#10b981', '#a78bfa', '#f59e0b', '#06b6d4', '#f43f5e'];
const cursor = ref(props.end);
const canvas = ref<SVGSVGElement>(), width = ref(900);
let resize: ResizeObserver | undefined;
onMounted(() => {
    resize = new ResizeObserver(entries => { width.value = Math.max(280, entries[0]?.contentRect.width ?? 900); });
    if (canvas.value) resize.observe(canvas.value);
});
onUnmounted(() => resize?.disconnect());
watch(() => props.series, () => {
    let last = props.start;
    for (const series of props.series) for (const point of series.values) last = Math.max(last, point[0]);
    cursor.value = Math.max(props.start, Math.min(props.end, last));
}, { immediate: true });
const left = 85, right = computed(() => width.value - 16), top = 10, bottom = 165;
const time = computed(() => cursor.value);
const maxValue = computed(() => {
    let value = props.unit === 'percent' ? 100 : 1;
    for (const series of props.series) for (const point of series.values) if (point[1] != null) value = Math.max(value, point[1]);
    return value;
});
const x = (timestamp: number) => left + (timestamp - props.start) / Math.max(1, props.end - props.start) * (right.value - left);
const y = (value: number) => bottom - value / maxValue.value * (bottom - top);
const paths = computed(() => props.series.map((series, index) => {
    let path = '', gap = true;
    for (const [timestamp, value] of series.values) {
        if (value == null || timestamp < props.start || timestamp > props.end) { gap = true; continue; }
        path += `${gap ? 'M' : 'L'}${x(timestamp).toFixed(2)},${y(value).toFixed(2)} `; gap = false;
    }
    const markers = series.values.filter((point, position, points) => point[1] != null && point[0] >= props.start && point[0] <= props.end
        && (position === 0 || points[position - 1][1] == null) && (position === points.length - 1 || points[position + 1][1] == null));
    return { ...series, path, markers, color: colors[index % colors.length] };
}));
const current = computed(() => paths.value.map(series => {
    let closest: ObservabilityDisplay.HistoryPoint | undefined;
    for (const point of series.values) if (!closest || Math.abs(point[0] - time.value) < Math.abs(closest[0] - time.value)) closest = point;
    return { name: series.name, color: series.color, value: closest && Math.abs(closest[0] - time.value) <= props.step / 2 + 1 ? closest[1] : undefined };
}));
const axisTime = (timestamp: number) => new Date(timestamp * 1000).toLocaleString(undefined, props.end - props.start > 86400 ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
const moveCursor = (event: PointerEvent) => {
    const svg = event.currentTarget as SVGSVGElement, rect = svg.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * width.value - left) / (right.value - left)));
    cursor.value = Math.round(props.start + fraction * (props.end - props.start));
};
</script>

<template>
    <section class="history-chart" :aria-label="title" data-testid="history-chart">
        <h4>{{ title }}</h4>
        <svg ref="canvas" :viewBox="`0 0 ${width} 200`" role="img" :aria-label="title" @pointermove="moveCursor" @pointerdown="moveCursor">
            <g v-for="fraction in [0, .5, 1]" :key="fraction">
                <line :x1="left" :x2="right" :y1="y(maxValue * fraction)" :y2="y(maxValue * fraction)" class="history-grid" />
                <text :x="left - 8" :y="y(maxValue * fraction) + 4" text-anchor="end">{{ ObservabilityDisplay.formatHistoryValue(maxValue * fraction, unit) }}</text>
            </g>
            <path v-for="(series, index) in paths" :key="index" :d="series.path" fill="none" :stroke="series.color" stroke-width="2" vector-effect="non-scaling-stroke" />
            <g v-for="(series, index) in paths" :key="`markers-${index}`"><circle v-for="point in series.markers" :key="point[0]" :cx="x(point[0])" :cy="y(point[1]!)" r="2.5" :fill="series.color" /></g>
            <line :x1="x(time)" :x2="x(time)" :y1="top" :y2="bottom" class="history-cursor" />
            <text :x="left" y="190">{{ axisTime(start) }}</text><text :x="right" y="190" text-anchor="end">{{ axisTime(end) }}</text>
        </svg>
        <input v-model.number="cursor" class="history-time-slider" type="range" :min="start" :max="end" step="1" :aria-label="t('web.observability.chart_time')" />
        <div class="history-reading">
            <time>{{ axisTime(time) }}</time>
            <span v-for="(series, index) in current" :key="index"><i :style="{ background: series.color }" />{{ series.name }} <strong>{{ ObservabilityDisplay.formatHistoryValue(series.value, unit) }}</strong></span>
        </div>
    </section>
</template>

<style scoped>
.history-chart { border: 1px solid var(--p-content-border-color); background: var(--p-content-background); border-radius: .6rem; padding: .85rem; min-width: 0; }
h4 { font-size: .875rem; font-weight: 600; margin: 0 0 .5rem; }
svg { display: block; width: 100%; overflow: visible; }
svg text { fill: var(--p-text-muted-color); font-size: 12px; }
.history-grid { stroke: var(--p-content-border-color); }
.history-cursor { stroke: var(--p-text-muted-color); stroke-dasharray: 3 4; }
.history-time-slider { width: 100%; height: 5px; accent-color: var(--p-primary-color); margin: .25rem 0 .75rem; cursor: pointer; }
.history-reading { display: flex; gap: .5rem 1rem; flex-wrap: wrap; font-size: .75rem; color: var(--p-text-muted-color); }
.history-reading time { flex-basis: 100%; }
.history-reading span { display: inline-flex; gap: .35rem; align-items: center; overflow-wrap: anywhere; }
.history-reading strong { color: var(--p-text-color); font-variant-numeric: tabular-nums; }
.history-reading i { flex: 0 0 7px; height: 7px; border-radius: 50%; }
@media (max-width: 500px) { .history-chart { padding: .6rem; } svg { min-height: 125px; } }
</style>
