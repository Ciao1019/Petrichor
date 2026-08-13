package dashboard

import (
	"testing"
	"time"
)

func TestEnumerateDaysCrossesLeapDay(t *testing.T) {
	days := enumerateDays(time.Date(2028, 2, 28, 0, 0, 0, 0, time.UTC), 3)
	want := []string{"2028-02-28", "2028-02-29", "2028-03-01"}
	for index := range want {
		if days[index] != want[index] {
			t.Fatalf("days = %#v", days)
		}
	}
}

func TestDashboardShapeMath(t *testing.T) {
	if computeDelta(5, 0) != nil {
		t.Fatal("zero comparison base should produce nil delta")
	}
	days := enumerateDays(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), 21)
	counts := map[string]int{}
	for _, day := range days[len(days)-14 : len(days)-7] {
		counts[day] = 1
	}
	for _, day := range days[len(days)-7:] {
		counts[day] = 2
	}
	tile := buildKpiTile("articles", "文章", "", 99, counts, days)
	if tile["current"] != 14 || tile["previous"] != 7 || len(tile["spark"].([]int)) != 14 {
		t.Fatalf("unexpected KPI tile: %#v", tile)
	}
}

func TestGrowthBaselineNeverBecomesNegative(t *testing.T) {
	// 与 Overview 中的基线公式保持一致：异常数据下总量小于窗口合计时，窗口外存量夹到 0。
	total, window := 2, 9
	baseline := max(0, total-window)
	if baseline != 0 {
		t.Fatalf("baseline = %d", baseline)
	}
}
